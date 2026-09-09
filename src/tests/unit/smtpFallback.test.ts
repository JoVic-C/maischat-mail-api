import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import smtpService from '../../services/smtp.service';

/**
 * SMTP padrão da plataforma, montado a partir do .env.
 *
 * O ponto sensível é o `secure`. Ele era fixo em `false`, e o buildTransporter só
 * deriva da porta quando o valor está AUSENTE (`creds.secure ?? porta === 465`) — um
 * `false` explícito passa direto. Na 465, que é TLS desde o primeiro byte, a conexão
 * morria em "Greeting never received", e o servidor ficava sem SMTP padrão sem que
 * nada na configuração parecesse errado.
 */
describe('SMTP padrão da plataforma', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.XMAILER_SMTP_HOST = 'mail.exemplo.com.br';
    process.env.XMAILER_SMTP_USER = 'envio@exemplo.com.br';
    process.env.XMAILER_SMTP_PASS = 'senha';
    process.env.XMAILER_SMTP_SECURE = '';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('usa TLS direto na porta 465', () => {
    process.env.XMAILER_SMTP_PORT = '465';
    expect(smtpService.getFallbackSmtp()?.secure).toBe(true);
  });

  it('não usa TLS direto na 587, onde o TLS vem por STARTTLS', () => {
    process.env.XMAILER_SMTP_PORT = '587';
    expect(smtpService.getFallbackSmtp()?.secure).toBe(false);
  });

  it('sem porta definida, assume 587', () => {
    process.env.XMAILER_SMTP_PORT = '';
    const smtp = smtpService.getFallbackSmtp();
    expect(smtp?.port).toBe(587);
    expect(smtp?.secure).toBe(false);
  });

  it('a variável explícita vence a convenção da porta', () => {
    // Para o servidor fora do padrão: TLS direto numa porta que não é a 465.
    process.env.XMAILER_SMTP_PORT = '2465';
    process.env.XMAILER_SMTP_SECURE = 'true';
    expect(smtpService.getFallbackSmtp()?.secure).toBe(true);

    process.env.XMAILER_SMTP_PORT = '465';
    process.env.XMAILER_SMTP_SECURE = 'false';
    expect(smtpService.getFallbackSmtp()?.secure).toBe(false);
  });

  it('sem host, usuário ou senha não há SMTP padrão', () => {
    process.env.XMAILER_SMTP_PASS = '';
    expect(smtpService.getFallbackSmtp()).toBeNull();
  });

  it('o remetente cai no usuário quando XMAILER_FROM_EMAIL não é definido', () => {
    process.env.XMAILER_SMTP_PORT = '465';
    process.env.XMAILER_FROM_EMAIL = '';
    expect(smtpService.getFallbackSmtp()?.fromEmail).toBe('envio@exemplo.com.br');
  });
});
