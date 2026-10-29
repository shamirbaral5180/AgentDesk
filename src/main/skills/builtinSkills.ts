export type BuiltinSkill = {
  id: string
  name: string
  provider: string
  description: string
  summary: string
  body: string
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: 'google-code-review',
    name: 'Google-style code review',
    provider: 'Google engineering practice',
    description: 'Small changes, clear intent, tests, and respectful review.',
    summary:
      'Keep changes small and focused. Explain why, not only what. Prefer readability over cleverness. Require tests for behavior. Review for correctness, design, complexity, tests, naming, and comments. Block only on correctness or maintainability, not taste.',
    body: [
      'Use this checklist for implementation and review:',
      '- Keep each change small enough to review in one sitting.',
      '- State the user-visible behavior and the reason for the change.',
      '- Prefer the simplest design that satisfies the requirement.',
      '- Add or update tests for behavior, edge cases, and failure paths.',
      '- Check naming, error handling, logging, and comments.',
      '- Avoid dead code, duplicated logic, and hidden global state.',
      '- Preserve existing conventions unless there is a clear reason to change them.',
      '- Review comments should be specific, actionable, and about the code, not the author.',
      '- Approve when the change is correct and maintainable; do not demand personal preferences.'
    ].join('\n')
  },
  {
    id: 'web-performance',
    name: 'Web performance and Core Web Vitals',
    provider: 'Google web.dev practice',
    description: 'Fast loading, stable layout, responsive interaction.',
    summary:
      'Optimize LCP, CLS, and INP. Avoid layout shifts. Lazy-load below-the-fold work. Keep JavaScript small. Use responsive images and font-display. Measure before and after.',
    body: [
      'Web performance checklist:',
      '- Measure LCP, CLS, and INP before changing code.',
      '- Keep the critical path small: defer non-critical scripts and styles.',
      '- Reserve space for images, ads, and dynamic content to prevent layout shift.',
      '- Use responsive images with width and height attributes.',
      '- Prefer system fonts or font-display: swap for web fonts.',
      '- Avoid unnecessary client-side JavaScript and large dependencies.',
      '- Lazy-load below-the-fold components and heavy routes.',
      '- Cache static assets and use compression at the server or edge.',
      '- Re-measure after the change and record the result.'
    ].join('\n')
  },
  {
    id: 'accessibility',
    name: 'Accessible product UI',
    provider: 'WCAG and Google accessibility practice',
    description: 'Keyboard, screen reader, contrast, focus, and semantics.',
    summary:
      'Use semantic HTML. Every interactive control works by keyboard. Keep visible focus. Label inputs and buttons. Maintain contrast. Announce errors. Respect reduced motion.',
    body: [
      'Accessibility checklist:',
      '- Use native semantic elements before ARIA.',
      '- Every action must be reachable and usable with a keyboard.',
      '- Keep a visible focus indicator; never remove focus outlines without a replacement.',
      '- Give every input an associated label and every icon button an accessible name.',
      '- Meet contrast requirements for text and interactive states.',
      '- Associate validation errors with the field and announce them.',
      '- Use headings in order and keep landmarks meaningful.',
      '- Respect prefers-reduced-motion for animation.',
      '- Test with keyboard navigation and a screen reader for critical flows.'
    ].join('\n')
  },
  {
    id: 'google-api-design',
    name: 'Google-style API design',
    provider: 'Google API design practice',
    description: 'Resource-oriented APIs, stable contracts, clear errors.',
    summary:
      'Model resources and standard methods. Use consistent naming, pagination, filtering, and errors. Validate input at the boundary. Version deliberately. Never leak internal errors or secrets.',
    body: [
      'API design checklist:',
      '- Model resources and use standard list, get, create, update, and delete semantics.',
      '- Keep names, IDs, timestamps, and error shapes consistent across endpoints.',
      '- Validate and normalize input at the boundary.',
      '- Return stable machine-readable error codes with safe human messages.',
      '- Use pagination for collections and explicit limits.',
      '- Make retries safe for create and update operations where possible.',
      '- Authenticate and authorize every protected operation.',
      '- Do not expose stack traces, secrets, or internal paths.',
      '- Document request, response, errors, and one real example per endpoint.'
    ].join('\n')
  },
  {
    id: 'cloudflare-reliability',
    name: 'Cloudflare-style reliability',
    provider: 'Cloudflare reliability practice',
    description: 'Timeouts, retries, graceful degradation, and observability.',
    summary:
      'Assume every dependency can fail. Set timeouts. Retry only idempotent work with backoff and jitter. Degrade gracefully. Log structured events. Protect the origin. Design for the edge and for partial failure.',
    body: [
      'Reliability checklist:',
      '- Put a timeout on every network and database call.',
      '- Retry only safe operations, with bounded exponential backoff and jitter.',
      '- Use circuit breaking or fail-fast behavior for unhealthy dependencies.',
      '- Degrade to a useful partial experience instead of a blank page.',
      '- Log structured events with request or trace identifiers, never secrets.',
      '- Expose health and readiness signals for services.',
      '- Cache safe content close to the user where appropriate.',
      '- Avoid single points of failure and unbounded queues.',
      '- Write down the failure mode and the recovery path for each critical dependency.'
    ].join('\n')
  },
  {
    id: 'secure-by-default',
    name: 'Secure by default',
    provider: 'Cloudflare and OWASP practice',
    description: 'Authentication, authorization, input safety, and secrets.',
    summary:
      'Authenticate and authorize on the server. Validate and encode input. Hash passwords with a modern KDF. Never trust client checks. Keep secrets out of source and logs. Use least privilege and deny by default.',
    body: [
      'Security checklist:',
      '- Enforce authentication and object-level authorization on the server.',
      '- Validate input against an allowlist and reject unexpected fields.',
      '- Encode output for its context; never build SQL or shell commands from raw input.',
      '- Hash passwords with a modern password KDF; never store plaintext.',
      '- Use short-lived sessions or tokens and rotate secrets.',
      '- Keep secrets in the secret store or environment, never in source or logs.',
      '- Apply least privilege to database, container, and cloud permissions.',
      '- Protect state-changing requests against CSRF where cookies are used.',
      '- Add rate limits and safe error messages to authentication endpoints.',
      '- Review guest access so it cannot read another user data.'
    ].join('\n')
  },
  {
    id: 'database-schema',
    name: 'Database schema and migrations',
    provider: 'Production database practice',
    description: 'Constraints, indexes, migrations, and safe rollback.',
    summary:
      'Model constraints in the database. Use forward-only migrations with backups. Index real query patterns. Avoid destructive changes without a plan. Verify with real queries and rollback steps.',
    body: [
      'Database checklist:',
      '- Define primary keys, foreign keys, unique constraints, and nullability deliberately.',
      '- Use one migration per logical change and keep it reviewable.',
      '- Back up before destructive or locking changes.',
      '- Index columns used by real filters, joins, and ordering.',
      '- Avoid unbounded queries and N+1 access patterns.',
      '- Make migrations safe for existing rows and rolling deploys.',
      '- Verify the migration and the important queries with real output.',
      '- Write the rollback or forward-fix path.',
      '- Never store secrets or plaintext passwords in application tables.'
    ].join('\n')
  },
  {
    id: 'google-testing',
    name: 'Google-style testing strategy',
    provider: 'Google testing practice',
    description: 'Test behavior at the right level and keep tests reliable.',
    summary:
      'Prefer many fast unit tests, fewer integration tests, and a small number of end-to-end tests. Test behavior and failure paths. Avoid flaky timing. Make failures explain themselves.',
    body: [
      'Testing checklist:',
      '- Test observable behavior, not private implementation details.',
      '- Cover the happy path, validation failures, permission failures, and dependency failures.',
      '- Prefer deterministic tests; control time, randomness, and network calls.',
      '- Keep unit tests fast; use integration tests for real contracts.',
      '- Use end-to-end tests only for critical user journeys.',
      '- Make each failure message identify the input and the expected result.',
      '- Do not weaken assertions to make a test pass.',
      '- Run the smallest relevant test first, then the broader suite.'
    ].join('\n')
  },
  {
    id: 'design-system',
    name: 'Design system quality',
    provider: 'Google Material and enterprise design practice',
    description: 'Consistent tokens, components, states, and responsive layout.',
    summary:
      'Use design tokens for color, spacing, type, and motion. Build components with default, hover, focus, active, disabled, loading, error, and empty states. Keep layouts responsive and content-led.',
    body: [
      'Design system checklist:',
      '- Use shared tokens for color, spacing, typography, radius, and elevation.',
      '- Define every component state: default, hover, focus, pressed, disabled, loading, error, empty.',
      '- Keep hierarchy clear with one primary action per area.',
      '- Use real content and sensible line lengths; avoid decorative clutter.',
      '- Design mobile-first and verify tablet and desktop layouts.',
      '- Keep tap targets large enough and spacing consistent.',
      '- Make loading, error, and empty states useful, not blank.',
      '- Reuse components instead of copying styles.',
      '- Verify contrast and keyboard focus before calling the UI complete.'
    ].join('\n')
  },
  {
    id: 'delivery-and-observability',
    name: 'Delivery and observability',
    provider: 'Cloudflare and industry delivery practice',
    description: 'CI, deployment safety, logs, metrics, and incident response.',
    summary:
      'Automate build, test, and deploy. Make releases reversible. Log the events needed to debug. Track errors and latency. Write a short incident note after a failure.',
    body: [
      'Delivery checklist:',
      '- Run typecheck, tests, and the build in CI for every change.',
      '- Keep configuration out of source and validate it at startup.',
      '- Use health checks and a reversible deployment path.',
      '- Log structured request, error, and dependency events without secrets.',
      '- Track error rate, latency, and saturation for critical paths.',
      '- Alert on user-visible failure, not only process crashes.',
      '- Write a short postmortem after an incident: impact, cause, fix, prevention.',
      '- Document how to run, test, deploy, and roll back the project.'
    ].join('\n')
  },
  {
    id: 'coordination-and-adr',
    name: 'Technical coordination and decision records',
    provider: 'Google and Cloudflare engineering practice',
    description: 'Delegate clearly, record decisions, and keep work unblocked.',
    summary:
      'Turn goals into small owned tasks with acceptance criteria and dependencies. Record important decisions with context and tradeoffs. Ask the Boss only when a product decision is genuinely needed. Keep the team moving.',
    body: [
      'Coordination checklist:',
      '- Break work into small tasks with one owner, a clear output, and acceptance criteria.',
      '- State dependencies and who must finish first.',
      '- Prefer parallel independent work; do not serialize without a reason.',
      '- Record decisions as context, options, decision, and rationale.',
      '- When an agent is blocked, give a concrete next step or reassign it.',
      '- Do not create duplicate tasks for work that is already done or in progress.',
      '- Ask the Boss with 2-6 concrete options only when the choice changes the product.',
      '- Report progress and blockers in plain English, without raw JSON or code dumps.'
    ].join('\n')
  }
]

const byId = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]))

export const DEFAULT_SKILLS_BY_ROLE: Record<string, string[]> = {
  coordinator: ['coordination-and-adr', 'google-code-review'],
  frontend: ['design-system', 'web-performance', 'accessibility', 'google-testing'],
  backend: ['google-api-design', 'cloudflare-reliability', 'secure-by-default', 'google-testing'],
  database: ['database-schema', 'cloudflare-reliability', 'secure-by-default'],
  qa: ['google-testing', 'secure-by-default', 'google-code-review', 'cloudflare-reliability'],
  devops: ['delivery-and-observability', 'cloudflare-reliability', 'secure-by-default']
}

export function defaultSkillsForRole(roleKey: string): string[] {
  return DEFAULT_SKILLS_BY_ROLE[roleKey] ?? ['google-code-review']
}

export function getBuiltinSkill(id: string): BuiltinSkill | null {
  return byId.get(id) ?? null
}

export function resolveSkills(ids: string[]): BuiltinSkill[] {
  return ids.map((id) => byId.get(id)).filter((skill): skill is BuiltinSkill => Boolean(skill))
}

export function skillPrompt(ids: string[]): string {
  const skills = resolveSkills(ids)
  if (skills.length === 0) {
    return 'No specialist skills are assigned.'
  }
  return skills
    .map(
      (skill) =>
        `### ${skill.name}\nProvider: ${skill.provider}\n${skill.summary}`
    )
    .join('\n\n')
}
