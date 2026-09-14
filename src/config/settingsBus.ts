import type { Redis } from 'ioredis';
import { logSideEffect } from '../utils/logger';
import { createRedisClient, redisConnection } from './redis';

/**
 * Aviso entre instâncias de que os ajustes da plataforma mudaram. O `limiter` do BullMQ é
 * fixado na construção do worker, então cada instância precisa recriar o seu. Escutar
 * abre conexão própria: um cliente em modo `subscribe` não aceita outros comandos.
 */
const CHANNEL = 'mailpulse:platform-settings:changed';

let subscriber: Redis | null = null;

export async function publishSettingsChanged(): Promise<void> {
  try {
    await redisConnection.publish(CHANNEL, '1');
  } catch (err) {
    // A configuração já foi salva; falhar ao propagar não derruba a requisição.
    logSideEffect('settingsBus.publish', err);
  }
}

/** Idempotente. O handler roda em toda instância, inclusive a que originou a mudança. */
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
