# Codex v2 Pet R7 Phase-One Audit

Generated: 2026-07-21T05:03:02+08:00

## Safety Result

- New GPT Image calls during phase one: **0**.
- R7 `imageGenerationCallCount` before and after the audit: **24**.
- No R8/R9 or replacement full workflow was created.
- No historical project, job, event, or artifact was deleted.
- Every live look POC remains disabled unless a run-bound one-call approval token is supplied.

## Authoritative R7 State

- Project: `cmrteijsv0002c3opa4jyt04z`
- Run: `cpr_3a7a7ee330675f6f5f3b4d58e0ef5b5b`
- Status: `failed` at 72%, billing refund status `refunded`
- Requested image model: `gpt-image-2`
- Reported successful response model: `gpt-image-2-codex`
- Requested visual QA model: `gpt-5.6-sol`
- Image call counter: 24
- Direction approval budget: 0
- Pending direction job: none
- Final spritesheet, ZIP, and knowledge document: absent

R7 predates persisted `image.call.started` events. Therefore `CodexPetRun.imageGenerationCallCount=24` is the authoritative outbound-call total. The run has 12 successful response-model entries (`gpt-image-2-codex`); failed transports did not return an actual model identifier.

## Durable Jobs

| Job | Kind | Status | Attempts |
| --- | --- | --- | --- |
| base-candidate-1 | base_candidate | completed | 1/3 |
| base-candidate-2 | base_candidate | completed | 1/3 |
| base-selection | visual_qa | completed | 1/3 |
| identity-guide | identity_guide | completed | 1/3 |
| row-idle | standard_row | completed | 2/3 |
| row-running-right | standard_row | completed | 1/3 |
| row-running-left | derived_row | completed | 2/3 |
| row-waving | standard_row | completed | 1/3 |
| row-jumping | standard_row | completed | 1/3 |
| row-failed | standard_row | completed | 2/3 |
| row-waiting | standard_row | completed | 2/3 |
| row-running | standard_row | completed | 1/3 |
| row-review | standard_row | completed | 2/3 |
| standard-atlas | deterministic_assembly | completed | 1/3 |
| look-mechanics | look_mechanics | completed | 1/3 |
| look-cardinals | look_cardinals | completed | 2/3 |
| cardinal-anchor-strip | deterministic_assembly | completed | 1/3 |
| look-a | look_row | failed | 3/3 |

The final `look-a` attempt failed because the image service was unavailable. Attempts 1 and 2 produced boards and QA reports; attempt 3 produced no image bytes.

## Reused Evidence

The read-only replay manifest contains 24 downloaded R7 artifacts:

- approved canonical base;
- all nine standard pose boards;
- stored 8x9 standard atlas and contact sheet;
- both cardinal boards, the approved four cardinal frames, their QA report, and the cardinal anchor strip;
- both available look-a boards and both QA reports.

## Offline Replay

`pnpm exec tsx .cc-tmp/replay-r7-offline.ts` completed without any model client:

- all 9 standard rows extracted successfully;
- row-major mapping, slot-edge/component checks, and jumping checks passed;
- replayed standard atlas validation passed;
- stored standard atlas validation passed;
- replayed atlas bytes exactly match the stored R7 atlas;
- both available look-a boards passed deterministic registration and continuity measurement.

Closest existing row 9:

- attempt 2;
- artifact `4f084224-36e5-44c2-8876-642358ef5d58`;
- registered continuity median alpha difference ratio `0.0342` (attempt 1 is `0.0452`);
- deterministic registration and continuity pass with 8 extracted frames;
- the persisted semantic QA failed, but its “only two readable poses” reason is contradicted by deterministic extraction and the inspected image;
- independent cardinal pixel distances show registered frame 5 is closer to the approved 270 family (`0.110233`) than to the required 090 family (`0.133898`), so the row still has a real 090/270 semantic break and cannot be approved.

Attempt 2 is diagnostic evidence only. It must not be treated as an approved row 9 or packaged into a deliverable.

## Contract And Recovery Coverage

- One cardinal appearance contract is injected into cardinal generation, cardinal QA, row 9, row 10, final QA, look-mechanics analysis, repair prompts, and labeled 16-direction QA.
- `000` is UP/back-family for a standing robot, `090` is screen-right, `180` is DOWN/front-family, and `270` is screen-left.
- Contradictory repair diagnostics are discarded.
- Labeled QA results that report 000 as front, 180 as rear/back, or swap 090/270 in either `expected` or `observed` are forced to `fail` even if the model says `pass`.
- Pre-despill magenta fringe is explicitly excluded from mirrored running-left QA; one final deterministic despill owns chroma cleanup.
- Completed standard rows and registered row 9 are durable and resume without regeneration.
- A direction failure moves the run to `awaiting_direction_review`; only one explicit approval grants one call, with no automatic retry or next-row call.
- The UI exposes the real image-call count and pending one-call approval.
- Image and QA selections are frozen into the run snapshot; qwen3.7 is rejected and filtered from the marketplace options.
- `codex-auto-review` is explicitly pinned to the Pixel route even when `CHATGPT_MODELS` is not present or omits that catalog entry; non-GPT marketplace models use Bailian.
- A failed/refunded source run can only enter delivery through a new zero-charge recovery run bound to exact final-atlas and QA checksums. The source run is never mutated.

### Recovery Packaging Crash Window

- Recovery runs are marked with `codex-pet-recovery-v1` in `inputSnapshot` and are the only runs allowed to use the zero-charge `not_required` billing lease.
- A recovery delivery in `packaging` with no `final-package` job, or with a job that has no recoverable checkpoint bytes yet, releases its lease and remains at `packaging`; it never replays base/standard/look generation, refunds, or creates a replacement visual job.
- A recovery delivery in `archiving` is also allowed to resume without provider access, covering a crash after final-package commit and before knowledge archival.
- Recovery packaging skips reference-object loading because its output is already bound to approved artifact checksums.
- Real PostgreSQL runner coverage now passes `34/34`, including the missing-checkpoint and empty-checkpoint recovery cases; recovery finalizer coverage remains `3/3`.

## Verification

- Real PostgreSQL recovery finalizer integration: 3/3 passed; the source run stayed at 24 calls while a synthetic two-POC recovery stayed at 26 through final `ready` archival.
- Real PostgreSQL runner integration: 33/33 passed.
- Real PostgreSQL runner integration after recovery crash-window protection: 34/34 passed.
- Direction registration and deterministic pipeline focused suite: 31/31 passed.
- Codex route/model/call-guard/recovery focused suite: 44 passed, 1 DB-only test skipped in the environment-free rerun; that same DB test passed in the `.env`-backed run.
- Visual QA parser suite: 15/15 passed.
- Web suite: 302/302 passed.
- Full codex-pet pipeline suite: 35/35 passed.
- API TypeScript and production build passed.
- `git diff --check` passed.

## Minimum Quota-Restored Plan

1. Ask for approval for exactly one `look-a` GPT Image call.
2. Generate only the complete 4x2 look-a row using R7 canonical, standard contact, approved cardinal strip, anchor storyboard, and prior failure diagnosis.
3. Use requested model `gpt-image-2`; require reported actual model `gpt-image-2-codex`; set `maxAttempts=1`; stop immediately on transport, deterministic, or semantic failure.
4. If row 9 passes, persist checksum-bound registration and `gpt-5.6-sol` semantic approval.
5. Separately ask for approval for exactly one `look-b` call. Do not infer that approval from row 9 approval.
6. If row 10 passes, run deterministic recovery finalization with zero additional image calls: assemble 1536x2288 atlas, single despill, atlas/continuity/blind/final QA, v2 ZIP, install link, and knowledge archive.

Maximum new GPT Image budget before final deterministic packaging: **2 calls, approved one at a time**.

## Remaining Acceptance Gap

Phase one is complete, but the full workflow is not yet accepted. It still lacks approved row 9 and row 10 bytes, final 1536x2288 spritesheet, v2 ZIP, install link, and knowledge document. Those can only be produced after quota restoration and the two separately approved real image calls above.
