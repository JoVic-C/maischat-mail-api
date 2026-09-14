import { Resolver } from 'node:dns/promises';
import { BadRequestError, NotFoundError } from '../errors';
import SendingDomain, {
  type CheckResult,
  type DomainChecks,
  type ISendingDomain,
  type SendingDomainStatus,
} from '../models/SendingDomain';
import SmtpSettings from '../models/SmtpSettings';

export type TxtLookup = (name: string) => Promise<string[]>;

export interface DnsRecordHint {
  check: 'spf' | 'dkim' | 'dmarc';
  type: 'TXT' | 'CNAME';
  host: string;
  value: string | null;
  note: string;
}

export interface SendingDomainView {
  domain: string;
  smtpNames: string[];
  status: SendingDomainStatus;
  checks: DomainChecks | null;
  checkedAt: Date | null;
  verifiedAt: Date | null;
  records: DnsRecordHint[];
}

export interface SendingDomainsOverview {
  enforced: boolean;
  platformHosts: string[];
  domains: SendingDomainView[];
}

const REVERIFY_AFTER_MS = 6 * 60 * 60 * 1000;

export class DnsUnavailableError extends Error {}

const resolver = new Resolver({ timeout: 3000, tries: 2 });

async function resolveTxt(name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw new DnsUnavailableError(`${name}: ${code ?? 'erro'}`);
  }
}

function list(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function platformConfig() {
  const hosts = list(process.env.SENDING_PLATFORM_HOSTS);
  return {
    hosts: hosts.length ? hosts : list(process.env.XMAILER_SMTP_HOST),
    spfInclude: (process.env.SENDING_SPF_INCLUDE ?? '').trim().toLowerCase(),
    dkimSelector: (process.env.SENDING_DKIM_SELECTOR ?? '').trim().toLowerCase() || 'mmail',
    dkimTarget: (process.env.SENDING_DKIM_TARGET ?? '').trim().toLowerCase(),
  };
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0
    ? ''
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

const pass = (detail: string): CheckResult => ({ state: 'pass', detail });
const fail = (detail: string): CheckResult => ({ state: 'fail', detail });

async function checkSpf(domain: string, lookup: TxtLookup, include: string): Promise<CheckResult> {
  const spf = (await lookup(domain)).map((r) => r.trim()).filter((r) => /^v=spf1(\s|$)/i.test(r));
  if (!spf.length) return fail('Nenhum registro SPF encontrado.');
  if (spf.length > 1) {
    return fail(`Há ${spf.length} registros SPF; o domínio precisa de um só, com todos os include juntos.`);
  }
  if (include && !spf[0].toLowerCase().split(/\s+/).includes(`include:${include}`)) {
    return fail(`O SPF não autoriza o servidor de envio: falta include:${include}.`);
  }
  return pass('O SPF autoriza o servidor de envio.');
}

function dkimKey(records: string[]): string | null {
  const record = records.find((r) => /(^|;)\s*(v=DKIM1|p=)/i.test(r));
  if (!record) return null;
  return record.match(/(?:^|;)\s*p=([^;]*)/i)?.[1].replace(/\s+/g, '') ?? '';
}

async function checkDkim(domain: string, lookup: TxtLookup, selector: string, target: string): Promise<CheckResult> {
  const host = `${selector}._domainkey.${domain}`;
  const key = dkimKey(await lookup(host));
  if (key === null) return fail(`Nenhuma chave DKIM em ${host}.`);
  if (!key) return fail('A chave DKIM publicada está vazia (revogada).');

  if (target) {
    const expected = dkimKey(await lookup(target));
    // Sem a chave de referência a falha é da plataforma, não do cliente.
    if (!expected) throw new DnsUnavailableError(`chave de referência ausente em ${target}`);
    if (key !== expected) return fail('A chave DKIM publicada não é a do servidor de envio.');
  }
  return pass('Chave DKIM publicada.');
}

async function checkDmarc(domain: string, lookup: TxtLookup): Promise<CheckResult> {
  const records = (await lookup(`_dmarc.${domain}`)).map((r) => r.trim()).filter((r) => /^v=DMARC1(\s|;|$)/i.test(r));
  if (!records.length) return fail('Nenhum registro DMARC encontrado.');
  if (records.length > 1) return fail('Há mais de um registro DMARC; o domínio precisa de um só.');
  const policy = records[0].match(/(?:^|;)\s*p=\s*(\w+)/i)?.[1].toLowerCase();
  if (!policy) return fail('O registro DMARC não define a política (p=).');
  return pass(`DMARC publicado, com política ${policy}.`);
}

export async function evaluateDomain(domain: string, lookup: TxtLookup): Promise<DomainChecks> {
  const cfg = platformConfig();
  const guard = async (run: () => Promise<CheckResult>): Promise<CheckResult> => {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof DnsUnavailableError)) throw err;
      return { state: 'error', detail: 'Não foi possível consultar o DNS agora. Tente de novo em instantes.' };
    }
  };

  const [spf, dkim, dmarc] = await Promise.all([
    guard(() => checkSpf(domain, lookup, cfg.spfInclude)),
    guard(() => checkDkim(domain, lookup, cfg.dkimSelector, cfg.dkimTarget)),
    guard(() => checkDmarc(domain, lookup)),
  ]);
  return { spf, dkim, dmarc };
}

export class SendingDomainService {
  lookupTxt: TxtLookup = resolveTxt;

  isPlatformHost(host: string): boolean {
    return platformConfig().hosts.includes(host.trim().toLowerCase());
  }

  recordsFor(domain: string): DnsRecordHint[] {
    const cfg = platformConfig();
    const include = cfg.spfInclude ? `include:${cfg.spfInclude}` : null;
    return [
      {
        check: 'spf',
        type: 'TXT',
        host: domain,
        value: include ? `v=spf1 ${include} ~all` : null,
        note: include
          ? `Se o domínio já tem SPF (o do Google Workspace, por exemplo), acrescente ${include} ao registro existente em vez de criar outro.`
          : 'Peça ao suporte o include do servidor de envio.',
      },
      {
        check: 'dkim',
        type: cfg.dkimTarget ? 'CNAME' : 'TXT',
        host: `${cfg.dkimSelector}._domainkey.${domain}`,
        value: cfg.dkimTarget || null,
        note: cfg.dkimTarget
          ? 'Não conflita com a chave do Google, que usa outro seletor.'
          : 'Peça ao suporte a chave pública DKIM do servidor de envio.',
      },
      {
        check: 'dmarc',
        type: 'TXT',
        host: `_dmarc.${domain}`,
        value: 'v=DMARC1; p=none',
        note: 'Se o domínio já tem DMARC, mantenha o registro existente.',
      },
    ];
  }

  private async platformDomains(): Promise<Map<string, string[]>> {
    const used = new Map<string, string[]>();
    if (!platformConfig().hosts.length) return used;

    const smtps = await SmtpSettings.find({}, { name: 1, host: 1, fromEmail: 1 }).lean();
    for (const smtp of smtps) {
      const domain = domainOf(smtp.fromEmail);
      if (!domain || !this.isPlatformHost(smtp.host)) continue;
      used.set(domain, [...(used.get(domain) ?? []), smtp.name]);
    }
    return used;
  }

  private toView(domain: string, smtpNames: string[], doc: ISendingDomain | null): SendingDomainView {
    return {
      domain,
      smtpNames,
      status: doc?.status ?? 'unverified',
      checks: doc?.checks ?? null,
      checkedAt: doc?.checkedAt ?? null,
      verifiedAt: doc?.verifiedAt ?? null,
      records: this.recordsFor(domain),
    };
  }

  async list(): Promise<SendingDomainsOverview> {
    const hosts = platformConfig().hosts;
    const used = await this.platformDomains();
    const cached = await SendingDomain.find({ domain: { $in: [...used.keys()] } }).lean();
    const byDomain = new Map(cached.map((doc) => [doc.domain, doc]));

    return {
      enforced: hosts.length > 0,
      platformHosts: hosts,
      domains: [...used.keys()]
        .sort()
        .map((domain) => this.toView(domain, used.get(domain) ?? [], byDomain.get(domain) ?? null)),
    };
  }

  async verify(rawDomain: string): Promise<SendingDomainView> {
    const domain = rawDomain.trim().toLowerCase();
    const used = await this.platformDomains();
    const smtpNames = used.get(domain);
    if (!smtpNames) throw new NotFoundError('Nenhum servidor SMTP deste cliente envia por esse domínio.');
    return this.toView(domain, smtpNames, await this.runCheck(domain));
  }

  private async runCheck(domain: string): Promise<ISendingDomain> {
    const checks = await evaluateDomain(domain, this.lookupTxt);
    const states = [checks.spf.state, checks.dkim.state, checks.dmarc.state];

    // DNS fora do ar não derruba um domínio que já estava liberado.
    if (states.includes('error') && !states.includes('fail')) {
      const existing = await SendingDomain.findOne({ domain }).lean();
      if (existing?.status === 'verified') return existing;
    }

    const verified = states.every((s) => s === 'pass');
    const now = new Date();
    const doc = await SendingDomain.findOneAndUpdate(
      { domain },
      {
        $set: {
          checks,
          checkedAt: now,
          status: verified ? 'verified' : 'unverified',
          ...(verified ? { verifiedAt: now } : {}),
        },
      },
      { upsert: true, new: true, lean: true }
    );
    return doc as ISendingDomain;
  }

  async assertSendable(smtp: { host: string; fromEmail: string }): Promise<void> {
    if (!this.isPlatformHost(smtp.host)) return;

    const domain = domainOf(smtp.fromEmail);
    if (!domain) throw new BadRequestError('O email do remetente do servidor SMTP é inválido.');

    let doc: ISendingDomain | null = await SendingDomain.findOne({ domain }).lean();
    const stale = !doc?.checkedAt || Date.now() - new Date(doc.checkedAt).getTime() > REVERIFY_AFTER_MS;
    if (doc?.status !== 'verified' || stale) doc = await this.runCheck(domain);
    if (doc.status === 'verified') return;

    const checks = doc.checks;
    const reason = checks ? [checks.spf, checks.dkim, checks.dmarc].find((c) => c.state !== 'pass')?.detail : '';
    throw new BadRequestError(
      `O domínio ${domain} ainda não está liberado para envio. ${reason ?? ''} Veja os registros em Ajustes › Domínios.`
        .replace(/\s+/g, ' ')
        .trim(),
      'DOMINIO_NAO_VERIFICADO'
    );
  }
}

export default new SendingDomainService();
