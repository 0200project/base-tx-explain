# Redesign brief — prepared 2026-09-04

## Revert

```
git checkout pre-redesign-2026-09-04 -- site/
```

Tag points at `57e0b5b`, pushed. The whole site comes back in one command.

## Run these, in this order, before you commit anything

```
sh scripts/claims-survive.sh     # 21 load-bearing sentences still present
bash scripts/stamp-css.sh        # content-hash the stylesheet link
bash scripts/site-check.sh       # 32 checks; must exit 0
```

`claims-survive.sh` is new and exists **only** for this redesign. `site-check.sh`
tests *patterns* — a free-tier claim must name the `/64`. It does not test
*presence*. A redesign that deletes the sentence entirely passes every existing
gate. That is the hole this fills, and it is proven to fail: remove one claim and
it refuses.

## What must survive, and why it is not optional

21 sentences in `scripts/claims-manifest.json`. Several replaced a live
falsehood earlier today. Every one is the kind of line that vanishes in a
rebuild, because it reads as copy and is actually a commitment.

| category | what it protects |
|---|---|
| `refusal` ×3 | We are not a declarant. Colder than our own offer document. |
| `checks-contract` ×3 | An empty `risk_flags` is not "clean". Our only claim a free explorer structurally cannot copy. |
| `free-tier` ×3 | Per IPv4 address **or IPv6 /64**. Was wrong on 16 surfaces this morning. |
| `rail` ×3 | USDC is the default *and why*; the receipt is the invoice. |
| `panel` ×4 | The `/about/` counters say what they actually count. |
| `asset` ×2 | XO2 has no utility today. |
| `self-host` ×1 | Single-writer: run one instance. Protects billing. |
| `services` ×2 | The document already exists — what makes 72 hours honest. |

**If the redesign wants to reword one of these, that is allowed.** Reword it,
then regenerate the manifest deliberately and say which line changed and why.
What is not allowed is regenerating the manifest to make the check go green.

## The test every new sentence must pass

Board doctrine, tonight. In `CLAUDE.md` at the repo root:

> **What does this sentence make a reasonable person think was CHECKED?**

Not "is every noun accurate". Scopes that must stay explicit: transaction,
address, time window, data source, risk, identity exposure, payment rail. No
clean-bill-of-health implication. **No beautiful ambiguity** — if a sentence
reads better because it is vague about what we checked, delete it.

## Known problems the redesign should actually fix

These are findings, not decoration. All read from the live site today.

1. **The first six words tell the buyer it is not for them.** "Machine-native
   tools for AI agents". The site names its audience four times in the first
   hundred words and every time it is a machine.
2. **Our best sentence is addressed to nobody.** The hero says "we tell *your
   agent* … when a safety check didn't actually run." An agent has no budget, no
   liability, and no reason to care. The person who does care is addressed
   nowhere.
3. **Every input on the site accepts exactly one thing: a transaction hash.**
   Two inputs, both hash-only, zero forms, zero contact forms. The only other
   route is a `mailto:`. A non-practitioner cannot tell us what they need. *(A
   contact form is queued behind this redesign.)*
4. **The playground's success state is blank.** Every failure state has careful
   prose; `showJSON()` is one line. We wrote paragraphs for every way it can go
   wrong and nothing for when it goes right.
5. **`/services/`'s only human paragraph opens with a sentence only a
   practitioner can parse** — "We run an x402 seller in production."

## Constraints that are not mine to relax

- **`/services/` is parked.** An unresolved commercial question about whose data
  the paid product examines. No price may be quoted for it until settled.
- **`/pay/` + `/pricing/` rail wording is drafted and held** for the founder,
  **both pages or neither** — they share a sentence, and changing one alone
  recreates a defect fixed this morning.
- **Asset pages go Security → Founder.** `/xo2/` included.
- **The register never reaches published copy.** Site copy is cased, plain, and
  written for someone who owes us no patience.

## Things that will break if you are not careful

- **14 of 16 pages carry page-specific inline `<script>`.** The playground's
  paywall and payment flows, `/about/`'s live `/healthz` panel, `/xo2/`'s live
  chain reader, `/pricing/`'s checkout. Restyling is safe; re-templating is not.
- **The stylesheet link is content-hashed.** Change `style.css` without running
  `stamp-css.sh` and returning visitors get new HTML with a ten-minute-old
  stylesheet. The gate refuses an unstamped page.
- **The CDN caches ~10 minutes.** Verify against the object store at an explicit
  ref, never the edge. Tonight the edge served old labels for minutes after a
  correct deploy — trusting either instrument alone gives the wrong answer.
- **Ten sessions share this checkout.** Stage by path. Assert per edit.
