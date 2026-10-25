/**
 * Vocabulário próprio da verificação de caixa postal, independente do provedor: o resto do
 * sistema só conhece estes quatro estados, e trocar de provedor muda apenas o mapeamento.
 */
export const VERIFICATION_STATUSES = ['deliverable', 'undeliverable', 'risky', 'unknown'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface ContactVerification {
  status: VerificationStatus;
  /** Resultado bruto do provedor, para auditoria e para explicar a classificação. */
  result: string;
  checkedAt: Date;
}

/**
 * Resultados da EmailListVerify (https://api.emaillistverify.com/api-doc).
 * - spamtrap é bloqueado: entrega, mas derruba a reputação do remetente.
 * - ok_for_all e disposable recebem o envio, mas ficam sinalizados.
 * - unknown, smtp_protocol e antispam_system não são cobrados e não provam nada.
 */
const ELV_STATUS: Record<string, VerificationStatus> = {
  ok: 'deliverable',
  email_disabled: 'undeliverable',
  dead_server: 'undeliverable',
  invalid_mx: 'undeliverable',
  invalid_syntax: 'undeliverable',
  spamtrap: 'undeliverable',
  ok_for_all: 'risky',
  disposable: 'risky',
  unknown: 'unknown',
  smtp_protocol: 'unknown',
  antispam_system: 'unknown',
};

const ELV_REASON: Record<string, string> = {
  ok: 'Caixa postal válida',
  email_disabled: 'Caixa postal não existe ou está desativada',
  dead_server: 'Domínio não existe ou não recebe emails',
  invalid_mx: 'Servidor de email do domínio mal configurado',
  invalid_syntax: 'Endereço com formato inválido',
  spamtrap: 'Armadilha de spam: enviar prejudica a reputação',
  ok_for_all: 'Domínio aceita qualquer endereço; a caixa não pôde ser confirmada',
  disposable: 'Email temporário (descartável)',
  unknown: 'Não foi possível verificar',
  smtp_protocol: 'Não foi possível verificar',
  antispam_system: 'O antispam do destino impediu a verificação',
};

export function classifyElvResult(result: string): VerificationStatus {
  return ELV_STATUS[result.trim().toLowerCase()] ?? 'unknown';
}

export function verificationReason(result: string): string {
  return ELV_REASON[result.trim().toLowerCase()] ?? 'Não foi possível verificar';
}
