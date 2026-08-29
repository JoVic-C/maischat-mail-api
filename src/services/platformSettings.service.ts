import { publishSettingsChanged } from '../config/settingsBus';
import { BadRequestError } from '../errors';
import PlatformSettings, {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  type IPlatformSettings,
  RATE_PER_MINUTE_MAX,
  RATE_PER_MINUTE_MIN,
  SINGLETON_KEY,
} from '../models/PlatformSettings';

export interface EngineSettings {
  workerConcurrency: number;
  ratePerMinute: number;
}

export interface PlatformSettingsView extends EngineSettings {
  updatedByEmail: string;
  updatedAt: string | null;
  /** Limites aceitos, para a tela não precisar duplicá-los. */
  bounds: {
    workerConcurrency: { min: number; max: number };
    ratePerMinute: { min: number; max: number };
  };
}

export interface UpdateSettingsInput {
  workerConcurrency: number;
  ratePerMinute: number;
}

/** Valor inicial, na primeira vez que a plataforma sobe. Depois vive no banco. */
function defaultsFromEnv(): EngineSettings {
  return {
    workerConcurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY) || 5,
    ratePerMinute: Number(process.env.EMAIL_WORKER_RATE_PER_MINUTE) || 600,
  };
}

export class PlatformSettingsService {
  /**
   * Cache do que o worker usa. O worker consulta a cada recriação, e a leitura não pode
   * depender do Mongo estar respondendo naquele instante — se falhar, o envio para.
   */
  private cache: EngineSettings | null = null;

  /** Documento atual, criando-o na primeira chamada. */
  private async load(): Promise<IPlatformSettings> {
    const existing = await PlatformSettings.findOne({ key: SINGLETON_KEY });
    if (existing) return existing;

    try {
      return await PlatformSettings.create({ key: SINGLETON_KEY, ...defaultsFromEnv() });
    } catch {
      // Outra instância criou entre o findOne e o create (índice único barrou).
      const created = await PlatformSettings.findOne({ key: SINGLETON_KEY });
      if (!created) throw new Error('Não foi possível carregar os ajustes da plataforma.');
      return created;
    }
  }

  /** Para a tela do superadmin. */
  async get(): Promise<PlatformSettingsView> {
    const doc = await this.load();
    return {
      workerConcurrency: doc.workerConcurrency,
      ratePerMinute: doc.ratePerMinute,
      updatedByEmail: doc.updatedByEmail,
      updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
      bounds: {
        workerConcurrency: { min: CONCURRENCY_MIN, max: CONCURRENCY_MAX },
        ratePerMinute: { min: RATE_PER_MINUTE_MIN, max: RATE_PER_MINUTE_MAX },
      },
    };
  }

  /**
   * O que o worker precisa. Serve do cache quando possível; se o banco falhar e já
   * houver cache, devolve o cache em vez de deixar o worker sem configuração.
   */
  async getEngineSettings(): Promise<EngineSettings> {
    try {
      const doc = await this.load();
      this.cache = { workerConcurrency: doc.workerConcurrency, ratePerMinute: doc.ratePerMinute };
      return this.cache;
    } catch (err) {
      if (this.cache) return this.cache;
      throw err;
    }
  }

  /** Invalida o cache — usado quando outra instância avisa que a configuração mudou. */
  invalidate(): void {
    this.cache = null;
  }

  async update(input: UpdateSettingsInput, updatedByEmail: string): Promise<PlatformSettingsView> {
    const { workerConcurrency, ratePerMinute } = input;

    // O express-validator já barra o grosso; esta checagem protege quem chama o service
    // direto (script, job) e mantém a regra junto da regra, não só na borda HTTP.
    if (workerConcurrency < CONCURRENCY_MIN || workerConcurrency > CONCURRENCY_MAX) {
      throw new BadRequestError(`Concorrência deve estar entre ${CONCURRENCY_MIN} e ${CONCURRENCY_MAX}.`);
    }
    if (ratePerMinute < RATE_PER_MINUTE_MIN || ratePerMinute > RATE_PER_MINUTE_MAX) {
      throw new BadRequestError(`Taxa deve estar entre ${RATE_PER_MINUTE_MIN} e ${RATE_PER_MINUTE_MAX} por minuto.`);
    }

    await this.load(); // garante que o documento existe antes do update
    await PlatformSettings.updateOne({ key: SINGLETON_KEY }, { workerConcurrency, ratePerMinute, updatedByEmail });

    this.cache = { workerConcurrency, ratePerMinute };

    // Avisa todas as instâncias (inclusive esta) a recriarem o worker com a taxa nova.
    await publishSettingsChanged();

    return this.get();
  }
}

export default new PlatformSettingsService();
