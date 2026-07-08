# ChampPreso Product Brief: The Repositioning

**Date:** 2026-07-08
**Owner:** Sreedeep Surapaneni (Champions Group)
**Status:** Direction locked. This document overrides all prior "presentation tool" framing.

---

## What this product is

ChampPreso is a **brainstorming partner**, not a presentation tool. The word "presentation" and everything that grew around it (Preso mode, Present toggles, staging-vs-live theater) is legacy confusion. Kill the framing.

The core experience: during any meeting or solo thinking session, ChampPreso sits on the side, **listens**, and continuously builds visual flowcharts, diagrams, and summaries on an Excalidraw canvas. The human talks. The canvas thinks along.

## The two entry paths

| Path | What happens |
|---|---|
| **Seed with existing work** | User drops in what they have so far (notes, a doc, bullet points, an earlier canvas). The agent immediately visualizes it on the canvas as the starting state, then builds on it as the conversation continues. |
| **Start fresh** | User writes a session intent ("get to a concrete plan for X"). The agent uses that intent to guide what it visualizes and how, extracting toward that goal as people talk. |

The **session intent** (today called "Agent instructions") is the steering wheel. If the intent is "get a concrete plan," the canvas converges toward a plan: phases, owners, dates. If the intent is "map the problem space," it diverges: clusters, questions, tensions. The intent shapes the agent's visual vocabulary for the whole session.

## The core loop

```
speech → transcription (local Moonshine) → agent turn → canvas edits → live canvas update
```

This loop already works. What is broken around it:

1. **Warmup latency.** The agent warms up only after the user presses start, taking long enough that the first minutes of real conversation get missed. The agent must be always-ready: warm in the background from the moment the app opens, re-warmed silently whenever settings or seed content change.
2. **Mode soup.** Staging/Preso, Present/Work, Strategy/Present/Co-think: three overlapping mode systems confuse the product story. One session lifecycle, one place to steer.
3. **Mid-session steering.** Nudges and guiding options exist but work unreliably on the backend. Steering must feel like whispering to a colleague, and must actually work.

## Who uses it

Deep (Group CMO) in Zoom brainstorms and leadership meetings, then teams across Champions Group companies. Users are business people, not developers. The tool must Just Work: open it, it is already listening-ready, one action to go live.

## Success criteria

A user coming out of a 45-minute meeting has a canvas artifact worth screenshotting into the follow-up email, with zero fiddling during the meeting itself. Nothing was lost, nothing was missed at the start, and steering it mid-meeting took one short sentence.

## What we are NOT building

Slide decks, presenter view, rehearsal mode, audience-facing anything. If a feature idea only makes sense "when presenting to an audience," it is out of scope.
