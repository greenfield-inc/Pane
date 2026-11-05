---
name: research-web
description: Perform technical web research using authoritative sources, synthesize the results, and save a cited research note in the repo. Use when external documentation or up-to-date behavior matters, or when handed one question the codebase cannot answer.
---

# Research Web

Produce a cited answer with direct links.

Workflow:
1. Restate the question and what would count as an answer. Break it into 2-5 research dimensions.
2. Prioritize official documentation, primary sources, and recent material, and check it applies to the version in use.
3. Browse broadly first, then open only the most promising sources. Cross-check anything that matters against a second source.
4. Compare sources, note conflicts and which is more authoritative, and verify version details.
5. Save the result to `./tmp/research/YYYY-MM-DD-web-description.md`. When another agent asked the question, return the report to it instead.
6. Present the report.

Report:
- The answer, in a few sentences
- Findings: claim, source, date or version
- Conflicts, gaps, and open questions
- Confidence: high, medium, or low

Requirements:
- Every factual claim needs a source URL.
- Distinguish official guidance from community opinion.
- Call out software versions, dates, and deprecations.
- Say plainly what you could not verify. Never fill a gap with a plausible guess.
- Stay inside the time box if you were given one.
- Prefer concise synthesis over long quote dumps.
- When answering for another agent, report findings only; it decides the design.
