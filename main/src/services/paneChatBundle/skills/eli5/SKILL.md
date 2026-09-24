---
name: eli5
description: Teach an unfamiliar topic from first principles with a picture-first HTML explanation, saved in Grain when connected. Use for "explain from scratch," "I'm lost," "what does this mean?", "explain in plain English," beginner questions about how something works, or /eli5; no explicit skill invocation is needed. Skip simple factual lookups and respect text-only requests.
argument-hint: "<topic, question, or path to explain>"
allowed-tools: Read, Grep, Glob, Bash, Write
---

# ELI5

## Task: $ARGUMENTS

The reader is not five. The reader is sharp, busy, and new to exactly
this. Respect both halves: no jargon they have not been given, and no
padding they have to wade through. One page, one topic, picture first.

## When to use it

- Use ELI5 when the person needs the foundations of a topic, not just a visual alongside an answer. Preserve the three floors below.
- For a companion to an existing discussion or review, use [explain-visually](../explain-visually/SKILL.md) without turning the task into a beginner lesson.
- Read that skill's HTML, saving, and verification guidance for this page too. ELI5 owns the teaching structure and reply format; produce one artifact, not two.

## Ground it

Before writing a word, find the truth of the topic in what is actually
here. A topic inside this repo means reading the real code and tracing
the real flow; a general topic means working from what you know and
saying so. Collect the three to five facts the whole explanation hangs
on. If the honest answer to "how does this work" is "it does not", the
page says that; an explainer that flatters a broken thing teaches the
wrong lesson.

## The three floors

The page renders per the html-explainer skill (tokens, components,
diagram rules, quality bar), structured as three floors the reader
descends by choice:

1. **The picture.** Masthead, then the opening diagram, then at most a
   hundred words: the one metaphor or plain-language mechanism that
   makes the topic click. A reader who stops here leaves with the right
   intuition and no vocabulary.
2. **The mechanism.** How it actually works, still in plain words, with
   one or two more diagrams or panel pairs (before/after, request/
   response, cause/effect). Each new term is introduced at the moment
   it pays for itself. A reader who stops here could explain it to
   someone else.
3. **The real names.** Inside `details` blocks: the proper terminology
   mapped to the plain words used above, the file:line anchors when the
   topic is code, the two or three things people commonly get wrong,
   and where to go deeper. A reader who opens these is ready for the
   real documentation.

## Metaphors

One metaphor, carried all the way through, beats three abandoned ones.
Pick it for mechanical honesty (the parts must correspond) rather than
charm, and drop it the moment it would mislead; some topics are best
explained literally, and a plain diagram of the actual parts is always
an acceptable metaphor. For an abstract topic with no visual shape,
diagram the relationship (what talks to what, what depends on what)
rather than forcing an object.

## Words

- Floor 1 under a hundred words; the whole page under six hundred.
  The budget counts every word the reader sees with `details` closed,
  captions, masthead, and SVG labels included; markup and style count
  nothing.
- Short declarative sentences. No "simply", no "just", no "magic".
- Numbers over adjectives: "answers in about 7 seconds" beats "fast".
- Every sentence survives the question "does the reader need this to
  understand the next one?"

## Boundaries

- Save the page in the existing task's Grain workspace when connected, following [explain-visually](../explain-visually/SKILL.md); pass the workspace ID and storage rule to any writer. Keep needed local files, respect audience/privacy limits, and fall back locally when disconnected. This overrides the renderer's local-only/no-publication defaults, not its visual standards.
- Accuracy outranks simplicity: simplify by omission, never by
  distortion, and name the biggest thing you left out in floor 3.
- The page is the deliverable; the chat reply is one line saying where
  it is and what it covers.
- No em dashes.
