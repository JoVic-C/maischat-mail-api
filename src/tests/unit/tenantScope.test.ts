import mongoose, { Schema, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { runAsSystem, runWithTenant } from '../../config/tenantContext';
import { tenantScope } from '../../models/plugins/tenantScope';

// Modelo descartável: a validação do Mongoose roda sem banco, e é nela que o plugin fixa o dono.
const schema = new Schema({ name: String });
schema.plugin(tenantScope);
const Registro = mongoose.model('RegistroTenantScopeTeste', schema);

describe('dono do documento no plugin de tenant', () => {
  it('na criação, o tenantId é sempre o do contexto, mesmo vindo outro no corpo', async () => {
    const meu = new Types.ObjectId();
    const alheio = new Types.ObjectId();

    await runWithTenant(meu, async () => {
      const doc = new Registro({ name: 'x', tenantId: alheio });
      await doc.validate();
      expect(String(doc.get('tenantId'))).toBe(String(meu));
    });
  });

  it('trocar o tenantId de um documento existente é recusado', async () => {
    const meu = new Types.ObjectId();

    await runWithTenant(meu, async () => {
      const doc = Registro.hydrate({ _id: new Types.ObjectId(), name: 'x', tenantId: meu });
      doc.set('tenantId', new Types.ObjectId());
      await expect(doc.validate()).rejects.toThrow(/outro cliente/);
    });
  });

  it('editar outros campos de um documento existente continua permitido', async () => {
    const meu = new Types.ObjectId();

    await runWithTenant(meu, async () => {
      const doc = Registro.hydrate({ _id: new Types.ObjectId(), name: 'x', tenantId: meu });
      doc.set('name', 'y');
      await expect(doc.validate()).resolves.toBeUndefined();
    });
  });

  it('no modo sistema, o tenantId informado é respeitado (scripts e workers)', async () => {
    const escolhido = new Types.ObjectId();

    await runAsSystem(async () => {
      const doc = new Registro({ name: 'x', tenantId: escolhido });
      await doc.validate();
      expect(String(doc.get('tenantId'))).toBe(String(escolhido));
    });
  });
});
