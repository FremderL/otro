# Runbook: responder reportes

**Responsable:** moderador de turno; admin para baneos o escalamiento. **Precondiciones:** sesión personal con MFA, capacitación y política vigente.

1. Abra la cola y clasifique prioridad sin copiar evidencia fuera del panel.
2. Consulte evidencia mínima; la lectura queda auditada.
3. Investigue contexto y posibles reportes relacionados. No sancione por volumen de denuncias solamente.
4. Documente una resolución factual de al menos 10 caracteres.
5. Moderador: puede suspender usuarios. Admin: puede banear/desbanear respetando jerarquía. Confirme username antes de ejecutar.
6. Verifique estado final, expulsión y eventos `report.updated`/`moderation.*`.

**Rollback:** desbanear o emitir una nueva acción correctiva; nunca edite ni borre la acción original. **Escalamiento:** amenazas creíbles, seguridad infantil, fraude o solicitud legal pasan al responsable designado; preserve evidencia conforme a retención.
