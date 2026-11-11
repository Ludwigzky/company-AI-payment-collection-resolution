// Test provider fixture only. Production always requires a separate HTTP reply.
export function isContextAuditRequest(init) {
  const body = JSON.parse(init.body);
  return body.messages[0]?.content.includes('你是独立上下文审核员');
}
export function auditRequestContext(init) {
  const content = JSON.parse(init.body).messages[1].content;
  return JSON.parse(typeof content === 'string' ? content : content[0].text);
}
export function passedAuditPayload(init) {
  const context = auditRequestContext(init);
  return {
    contextId: context.contextId, candidateDigest: context.candidateDigest, overall: 'passed',
    checks: context.legalContext.findings.map((finding) => ({
      findingId: finding.id, status: finding.status, verdict: 'supported',
      factIds: finding.factIds, clauseIds: finding.clauseIds,
      conditionIndices: finding.conditions.map((_, index) => index),
      evidenceGapIndices: finding.missingEvidence.map((_, index) => index),
      reasonCodes: ['reported_facts_unverified', 'conditions_require_evidence', ...(finding.status === 'not_applicable' ? ['excluded_on_reported_facts'] : [])],
    })),
    sectionChecks: context.sections.map(({ sectionId, requiredFactIds, requiredClauseIds }) => ({ sectionId, verdict: 'supported', factIds: requiredFactIds?.length ? requiredFactIds : ['fact-issueText'], clauseIds: requiredClauseIds ?? [] })),
  };
}
export function auditResponse(payload) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }), { headers: { 'Content-Type': 'application/json' } });
}
export function passedAuditResponse(init) { return auditResponse(passedAuditPayload(init)); }
