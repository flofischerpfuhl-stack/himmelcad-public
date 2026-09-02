const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

function escapeRegularExpression(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

/**
 * Match an axe selector against an exception glob. `*` is the only wildcard;
 * every other character is literal so CSS punctuation cannot become regex.
 */
export function selectorMatchesPattern(selector, pattern) {
  if (typeof selector !== 'string' || typeof pattern !== 'string' || pattern.length === 0)
    return false;
  const expression = pattern.split('*').map(escapeRegularExpression).join('.*');
  return new RegExp(`^${expression}$`, 'u').test(selector);
}

export function validateA11yExceptions(document) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.exceptions))
    throw new Error('a11y-exceptions.json must contain schemaVersion 1 and an exceptions array');
  for (const [index, exception] of document.exceptions.entries()) {
    for (const field of ['ruleId', 'selectorPattern', 'reason', 'owner', 'reviewDate'])
      if (typeof exception?.[field] !== 'string' || exception[field].trim().length === 0)
        throw new Error(`a11y exception ${index} has no non-empty ${field}`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(exception.reviewDate))
      throw new Error(`a11y exception ${index} reviewDate must use YYYY-MM-DD`);
  }
  return document.exceptions;
}

export function matchingA11yException(finding, exceptions) {
  return exceptions.find(
    (exception) =>
      exception.ruleId === finding.ruleId &&
      selectorMatchesPattern(finding.selector, exception.selectorPattern),
  );
}

/**
 * Annotate findings with their matching exception and select the release-gate
 * failures. Axe findings below serious remain visible but do not block WP-F3.
 */
export function gateA11yFindings(findings, exceptions) {
  const annotated = findings.map((finding) => ({
    ...finding,
    exception: matchingA11yException(finding, exceptions) ?? null,
  }));
  return {
    findings: annotated,
    blocking: annotated.filter(
      (finding) => BLOCKING_IMPACTS.has(finding.impact) && finding.exception === null,
    ),
  };
}

export function countA11yImpacts(findings) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
  for (const finding of findings) {
    const impact = Object.hasOwn(counts, finding.impact) ? finding.impact : 'unknown';
    counts[impact] += 1;
  }
  return counts;
}
