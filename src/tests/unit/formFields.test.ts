import { describe, expect, it } from 'vitest';
import { cleanValue, extractFields, normalizeKey, pickEmail, pickName } from '../../utils/formFields';

describe('campos de formulário', () => {
  it('JSON simples vira chave → texto', () => {
    const { fields } = extractFields({ Nome: 'Ana', 'E-mail': 'Ana@Empresa.com', Telefone: 11999990000 });
    expect(fields).toMatchObject({ nome: 'Ana', e_mail: 'Ana@Empresa.com', telefone: '11999990000' });
    expect(pickEmail(fields)).toBe('ana@empresa.com');
    expect(pickName(fields)).toBe('Ana');
  });

  it('entende o formato do Elementor, com o campo name do formulário sem roubar o do contato', () => {
    const body = {
      form: { id: 'a1b2', name: 'Contato do site' },
      fields: {
        name: { id: 'name', type: 'text', title: 'Nome', value: 'Bruno' },
        email: { id: 'email', type: 'email', title: 'Email', value: 'bruno@x.com' },
        message: { id: 'message', title: 'Mensagem', value: 'Quero um orçamento' },
      },
    };
    const { fields } = extractFields(body);
    expect(fields.name).toBe('Bruno');
    expect(fields.nome).toBe('Bruno');
    expect(fields.mensagem).toBe('Quero um orçamento');
    expect(fields.form_name).toBe('Contato do site');
    expect(pickEmail(fields)).toBe('bruno@x.com');
  });

  it('acha o email pelo valor quando o nome do campo não ajuda', () => {
    const { fields } = extractFields({
      form_response: { answers: [{ type: 'email', email: 'cris@x.com' }, { text: 'Cris' }] },
    });
    expect(pickEmail(fields)).toBe('cris@x.com');
  });

  it('campo configurado é obedecido à risca', () => {
    const { fields } = extractFields({ email: 'errado@x.com', email_contato: 'certo@x.com' });
    expect(pickEmail(fields, 'Email Contato')).toBe('certo@x.com');
    expect(pickEmail(fields, 'inexistente')).toBeNull();
  });

  it('listas de valores viram texto separado por vírgula', () => {
    expect(extractFields({ interesses: ['SEO', 'Ads'] }).fields.interesses).toBe('SEO, Ads');
  });

  it('honeypot preenchido marca como robô e não vira variável', () => {
    const robo = extractFields({ email: 'bot@x.com', _gotcha: 'http://spam' });
    expect(robo.honeypot).toBe(true);
    expect(robo.fields).not.toHaveProperty('gotcha');

    expect(extractFields({ email: 'gente@x.com', _gotcha: '' }).honeypot).toBe(false);
  });

  it('não guarda campos sensíveis', () => {
    const { fields } = extractFields({ email: 'a@x.com', senha: '123', password: 'x', numero_cartao: '4111' });
    expect(Object.keys(fields)).toEqual(['email']);
  });

  it('tira tags e caracteres de controle do valor', () => {
    expect(cleanValue('<a href="http://golpe">clique</a>')).toBe('a href="http://golpe" clique /a');
    expect(cleanValue('linha 1\r\nlinha 2')).toBe('linha 1 linha 2');
  });

  it('corta valores enormes e excesso de campos', () => {
    const muitos = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`campo${i}`, 'x']));
    expect(Object.keys(extractFields(muitos).fields)).toHaveLength(100);
    expect(extractFields({ texto: 'a'.repeat(5000) }).fields.texto).toHaveLength(1000);
  });

  it('não quebra com corpo vazio, texto solto ou aninhamento absurdo', () => {
    expect(extractFields(undefined).fields).toEqual({});
    expect(extractFields('texto solto').fields).toEqual({});
    let fundo: Record<string, unknown> = { email: 'fundo@x.com' };
    for (let i = 0; i < 20; i++) fundo = { nivel: fundo };
    expect(extractFields(fundo).fields).toEqual({});
  });

  it('chaves com acento e símbolos viram nomes de variável', () => {
    expect(normalizeKey('Número de funcionários?')).toBe('numero_de_funcionarios');
  });
});
