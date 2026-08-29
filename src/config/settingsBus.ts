import type { Redis } from 'ioredis';
import { logSideEffect } from '../utils/logger';
import { createRedisClient, redisConnection } from './redis';

/**
 * Aviso entre instâncias de que os ajustes da plataforma mudaram.
 *
 * Por que existe: o `limiter` do BullMQ é fixado na construção do Worker — mudar a taxa
 * exige recriar o worker. Com mais de uma instância da API no ar, salvar a configuração
 * numa delas não alcançaria as outras, e a plataforma ficaria com workers em taxas
 * diferentes até o próximo deploy. O canal do Redis resolve isso sem inventar
 * infraestrutura nova: o Redis já é dependência da fila.
 *
 * Publicar usa a conexão principal (é comando comum); escutar abre uma conexão própria,
 * porque um cliente em modo `subscribe` não aceita mais nada.
 */
const CHANNEL = 'mailpulse:platform-settings:changed';

let subscriber: Redis | null = null;

/** Avisa TODAS as instâncias (inclusive esta) que a configuração mudou. */
export async function publishSettingsChanged(): Promise<void> {
  try {
    await redisConnection.publish(CHANNEL, '1');
  } catch (err) {
    // A configuração já foi salva; não propagar não pode derrubar a requisição.
    // Esta instância recarrega assim mesmo — quem chama recarrega localmente.
    logSideEffect('settingsBus.publish', err);
  }
}

/**
 * Passa a escutar mudanças. Idempotente: chamar duas vezes não abre duas conexões.
 * O handler roda em toda instância, incluindo a que originou a mudança.
 */
export async function subscribeSettingsChanged(onChange: () => Promise<void>): Promise<void> {
  if (subscriber) return;

  subscriber = createRedisClient();
  subscriber.on('error', (err) => logSideEffect('settingsBus.subscriber', err));
  subscriber.on('message', (channel) => {
    if (channel !== CHANNEL) return;
    onChange().catch((err) => logSideEffect('settingsBus.onChange', err));
  });

  await subscriber.connect();
  await subscriber.subscribe(CHANNEL);
}

/** Fecha a conexão de escuta (shutdown da API). */
export async function closeSettingsBus(): Promise<void> {
  if (!subscriber) return;
  const client = subscriber;
  subscriber = null;
  try {
    await client.quit();
  } catch (err) {
    logSideEffect('settingsBus.close', err);
  }
}
