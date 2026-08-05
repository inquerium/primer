import { all, one, run, id, now, logEvent, parseJson } from '../db/index.ts';
import type { Domain, Skill } from '../domain/types.ts';
import { learnerContext } from '../record/context.ts';
import { nextTargets } from '../domain/scheduler.ts';
import { progressReport, exportRecord } from '../record/report.ts';
import { recompute, getMastery, currentP } from '../record/mastery.ts';
import {
  createLearner,
  listLearners,
  resolveLearner,
  noteInterest,
  addAccommodation,
  accommodations,
} from '../record/learners.ts';
import {
  recordObservations,
  evidenceFor,
  startSession,
  endSession,
  noteAffect,
  noteMisconception,
  resolveMisconception,
} from '../record/observations.ts';
import {
  saveInterface,
  listInterfaces,
  getInterface,
  readInterfaceHtml,
  scoreInterface,
} from '../surface/store.ts';
import {
  planActivity,
  queue,
  readyCount,
  recentReviewFeedback,
  describe as describeActivity,
} from '../record/queue.ts';
import { validateInterface, explain } from '../surface/validate.ts';
import { listArtifacts, describeArtifact, markReviewed } from '../record/artifacts.ts';
import { settings } from '../agent/config.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, ctx: ToolContext) => unknown;
}

export interface ToolContext {
  /** Base URL of the local surface server, e.g. http://127.0.0.1:7333 */
  origin: string;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: 'object', properties, required });

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const TOOLS: ToolDef[] = [
  /* ------------------------------------------------------------- learners -- */
  {
    name: 'list_learners',
    description: 'List the children in this record. Start here if you do not know who you are working with.',
    inputSchema: obj({}),
    handler: () => listLearners(),
  },
  {
    name: 'create_learner',
    description:
      'Add a child to the record. Only a display name is required — keep personal data minimal.',
    inputSchema: obj(
      {
        display_name: str('What the child is called. A first name or nickname is enough.'),
        birth_date: str(
          'ISO date. Used to pick a sensible starting guess for a first placement ' +
            'session — never shown as a judgment, and evidence overrides it either way.',
        ),
        pronouns: str('e.g. "she/her". Omit if unknown — do not guess.'),
        locale: str('BCP-47 tag, default en-US'),
        timezone: str('IANA timezone'),
      },
      ['display_name'],
    ),
    handler: (a) => createLearner(a),
  },

  /* -------------------------------------------------------------- context -- */
  {
    name: 'learner_context',
    description:
      'THE MAIN TOOL. Everything you need to teach this child right now: what they know, ' +
      'what is due for review, what they are stuck on, their misconceptions, what they love, ' +
      'the accommodations you must honor, how recent sessions felt, and which interfaces you ' +
      'have built for them that worked. Call this first in every session. Do not ask the ' +
      'child questions the record already answers.',
    inputSchema: obj(
      {
        learner: str('Learner id or display name.'),
        domains: {
          type: 'array',
          items: { type: 'string', enum: ['reading', 'writing', 'math'] },
          description: 'Optional filter. Omit to see the whole child.',
        },
        target_count: num('How many candidate targets to return. Default 8.'),
      },
      ['learner'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return learnerContext(learner.id, {
        domains: a.domains as Domain[] | undefined,
        targetCount: a.target_count,
      });
    },
  },
  {
    name: 'next_targets',
    description:
      'Just the scheduling answer: what to work on next and why (lapsed, review due, stuck, ' +
      'or the next teachable thing). learner_context already includes this.',
    inputSchema: obj(
      {
        learner: str('Learner id or display name.'),
        domains: { type: 'array', items: { type: 'string', enum: ['reading', 'writing', 'math'] } },
        limit: num('Default 8.'),
        include_review: bool('Include due spaced-repetition reviews. Default true.'),
      },
      ['learner'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return nextTargets(learner.id, {
        domains: a.domains,
        limit: a.limit,
        includeReview: a.include_review,
      }).map((t) => ({
        skill_id: t.skill.id,
        name: t.skill.name,
        domain: t.skill.domain,
        strand: t.skill.strand,
        probe: parseJson<unknown>(t.skill.probe, null),
        p_known: t.p_known,
        reason: t.reason,
        priority: t.priority,
        attempts_so_far: t.opportunities,
      }));
    },
  },

  /* ------------------------------------------------------------- evidence -- */
  {
    name: 'record_observations',
    description:
      'Write evidence. One row per attempt — what you asked, what they did, whether it was ' +
      'right, how long it took. Mastery updates automatically. Record wrong answers with the ' +
      'actual response text: that is what makes misconceptions findable later. Interfaces you ' +
      'generate report their own attempts through the primer runtime, so you only need this ' +
      'for work you do conversationally or judge yourself.',
    inputSchema: obj(
      {
        learner: str('Learner id or display name.'),
        session_id: str('Optional session to attach these to.'),
        observations: {
          type: 'array',
          description: 'One entry per attempt.',
          items: obj({
            skill_id: str('Which skill this is evidence about.'),
            correct: num('1 right, 0 wrong, or a fraction for partial credit.'),
            item: str('Exactly what was asked, e.g. the word "cape".'),
            response: str('Exactly what the child did or said. Keep it verbatim.'),
            expected: str('The correct answer, if useful.'),
            latency_ms: num('Time to respond.'),
            hint_count: num('Hints given before they got it. Discounts the credit.'),
            modality: {
              type: 'string',
              enum: ['spoken', 'typed', 'drawn', 'selected', 'manipulated'],
            },
            kind: {
              type: 'string',
              enum: ['attempt', 'probe', 'self_report', 'tutor_judgment', 'artifact_review'],
            },
          }),
        },
      },
      ['learner', 'observations'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return recordObservations(
        learner.id,
        (a.observations ?? []).map((o: any) => ({ ...o, session_id: o.session_id ?? a.session_id })),
      );
    },
  },
  {
    name: 'evidence_for',
    description:
      'The raw attempts behind a mastery estimate. Use when a parent asks "why does it think ' +
      'that", or when you want to see the actual wrong answers before deciding how to reteach.',
    inputSchema: obj(
      { learner: str('Learner id or name.'), skill_id: str('Skill to inspect.'), limit: num('Default 25.') },
      ['learner', 'skill_id'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      const m = getMastery(learner.id, a.skill_id);
      return {
        mastery: m
          ? { ...m, p_known_now: Number(currentP(m).toFixed(3)) }
          : null,
        observations: evidenceFor(learner.id, a.skill_id, a.limit ?? 25),
      };
    },
  },

  /* ------------------------------------------------------------- sessions -- */
  {
    name: 'start_session',
    description: 'Open a session. Returns a session id to attach observations to.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        mode: { type: 'string', enum: ['play', 'practice', 'assess', 'story', 'free'] },
        target_skills: { type: 'array', items: { type: 'string' } },
      },
      ['learner'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return startSession(learner.id, { mode: a.mode, target_skills: a.target_skills });
    },
  },
  {
    name: 'end_session',
    description:
      'Close a session and leave a note for your future self. Write the summary the way a ' +
      'tutor writes to the tutor who comes next: what actually happened, what to try tomorrow.',
    inputSchema: obj(
      {
        session_id: str('Session to close.'),
        summary: str('What happened, in plain language.'),
        energy: str('high | ok | low | done'),
      },
      ['session_id'],
    ),
    handler: (a) => endSession(a.session_id, { summary: a.summary, energy: a.energy }),
  },
  {
    name: 'note_affect',
    description:
      'Record how it felt, not how it scored. Frustration, delight, flow, fatigue, boredom, ' +
      'pride. This drives how future sessions are shaped, and is often more important than accuracy.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        signal: {
          type: 'string',
          enum: ['frustration', 'delight', 'flow', 'fatigue', 'boredom', 'pride'],
        },
        intensity: num('0 to 1. Default 0.5.'),
        evidence: str('What made you think so. Be concrete.'),
        session_id: str('Optional session.'),
      },
      ['learner', 'signal'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      noteAffect(learner.id, a.signal, {
        intensity: a.intensity,
        evidence: a.evidence,
        session_id: a.session_id,
      });
      return { ok: true };
    },
  },

  /* ------------------------------------------------------ the child's mind -- */
  {
    name: 'note_misconception',
    description:
      'Record a stable wrong model, not a wrong answer. "Reads every vowel as short." ' +
      '"Thinks more digits always means bigger." Repeat calls with the same wording strengthen ' +
      'the existing entry. This is the most valuable thing in the record — it is what a great ' +
      'tutor carries in their head and what every worksheet app throws away.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        pattern: str('The wrong rule, stated as the child seems to hold it. Short and falsifiable.'),
        skill_id: str('Related skill, if any.'),
        example: str('A concrete instance you just saw.'),
        strategy: str('What you tried against it, and whether it helped.'),
      },
      ['learner', 'pattern'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return noteMisconception(learner.id, a.pattern, {
        skill_id: a.skill_id,
        example: a.example,
        strategy: a.strategy,
      });
    },
  },
  {
    name: 'resolve_misconception',
    description: 'Mark a misconception as fading or resolved once the evidence supports it.',
    inputSchema: obj(
      {
        misconception_id: str('Id from note_misconception or learner_context.'),
        status: { type: 'string', enum: ['fading', 'resolved'] },
        strategy: str('What finally worked. Worth writing down.'),
      },
      ['misconception_id', 'status'],
    ),
    handler: (a) => {
      resolveMisconception(a.misconception_id, a.status, a.strategy);
      return { ok: true };
    },
  },
  {
    name: 'note_interest',
    description:
      'Record what the child cares about. Use it liberally — every generated story problem, ' +
      'character, and interface should come out of this list. Interests decay if unmentioned, ' +
      'so re-noting an ongoing obsession is useful, not redundant.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        topic: str('e.g. "dinosaurs", "her dog Biscuit", "Minecraft redstone"'),
        note: str('Detail worth remembering.'),
        source: str('observed | parent | self_report | tutor'),
      },
      ['learner', 'topic'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return noteInterest(learner.id, a.topic, { note: a.note, source: a.source });
    },
  },
  {
    name: 'add_accommodation',
    description:
      'Record a standing constraint on how this child must be taught: dyslexia-friendly type, ' +
      'audio first, no timers, high contrast, extra processing time, motor limits. ' +
      'Every interface you generate afterwards must honor all active accommodations.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        kind: str('typography | audio_first | no_timers | contrast | pacing | motor | attention | language'),
        detail: str('Specifics, in the imperative: "no countdown timers of any kind".'),
        set_by: str('parent | teacher | specialist | tutor'),
      },
      ['learner', 'kind', 'detail'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return addAccommodation(learner.id, a.kind, a.detail, a.set_by ?? 'parent');
    },
  },
  {
    name: 'add_note',
    description: 'Free-text note from a human or from you. Notes surface in learner_context.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        text: str('The note.'),
        author_role: str('parent | teacher | tutor | specialist'),
        visibility: str('all | adults_only'),
      },
      ['learner', 'text'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      const noteId = id('not');
      run(
        `INSERT INTO note (id, learner_id, author_role, text, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        noteId,
        learner.id,
        a.author_role ?? 'tutor',
        a.text,
        a.visibility ?? 'all',
        now(),
      );
      return { id: noteId };
    },
  },
  {
    name: 'set_goal',
    description: 'Record what a parent, teacher, or the child themselves is aiming for.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        text: str('The goal, in their words.'),
        set_by: str('parent | teacher | learner | tutor'),
        target_date: str('ISO date, optional.'),
      },
      ['learner', 'text'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      const goalId = id('gol');
      run(
        `INSERT INTO goal (id, learner_id, text, set_by, target_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
        goalId,
        learner.id,
        a.text,
        a.set_by ?? 'parent',
        a.target_date ?? null,
        now(),
      );
      return { id: goalId };
    },
  },

  /* ----------------------------------------------------------- curriculum -- */
  {
    name: 'skill_search',
    description:
      'Find skills by name, id fragment, domain, or strand. Use to get the skill_id you need ' +
      'before recording an observation.',
    inputSchema: obj({
      query: str('Text to match against id, name, description, strand.'),
      domain: { type: 'string', enum: ['reading', 'writing', 'math'] },
      grade_band: { type: 'string', enum: ['pk', 'k', '1', '2', '3'] },
      limit: num('Default 25.'),
    }),
    handler: (a) => {
      const q = `%${(a.query ?? '').toLowerCase()}%`;
      return all<Skill>(
        `SELECT * FROM skill
          WHERE (? = '%%' OR lower(id) LIKE ? OR lower(name) LIKE ?
                 OR lower(coalesce(description,'')) LIKE ? OR lower(strand) LIKE ?)
            AND (? IS NULL OR domain = ?)
            AND (? IS NULL OR grade_band = ?)
          ORDER BY domain, strand, ordinal LIMIT ?`,
        q, q, q, q, q,
        a.domain ?? null, a.domain ?? null,
        a.grade_band ?? null, a.grade_band ?? null,
        a.limit ?? 25,
      ).map((s) => ({
        id: s.id,
        name: s.name,
        domain: s.domain,
        strand: s.strand,
        grade_band: s.grade_band,
        description: s.description,
        probe: parseJson<unknown>(s.probe, null),
      }));
    },
  },
  {
    name: 'skill_detail',
    description:
      'One skill in full: its probe template, its prerequisites, what it unlocks, and this ' +
      "child's current state on it if a learner is given.",
    inputSchema: obj({ skill_id: str('Skill id.'), learner: str('Optional learner id or name.') }, ['skill_id']),
    handler: (a) => {
      const skill = one<Skill>(`SELECT * FROM skill WHERE id = ?`, a.skill_id);
      if (!skill) throw new Error(`No skill "${a.skill_id}"`);
      const prereqs = all<{ id: string; name: string }>(
        `SELECT s.id, s.name FROM skill_edge e JOIN skill s ON s.id = e.from_skill
          WHERE e.to_skill = ? AND e.kind = 'prerequisite'`,
        a.skill_id,
      );
      const unlocks = all<{ id: string; name: string }>(
        `SELECT s.id, s.name FROM skill_edge e JOIN skill s ON s.id = e.to_skill
          WHERE e.from_skill = ? AND e.kind = 'prerequisite'`,
        a.skill_id,
      );
      let mastery = null;
      if (a.learner) {
        const learner = resolveLearner(a.learner);
        const m = getMastery(learner.id, a.skill_id);
        mastery = m ? { ...m, p_known_now: Number(currentP(m).toFixed(3)) } : null;
      }
      return {
        ...skill,
        probe: parseJson<unknown>(skill.probe, null),
        tags: parseJson<string[]>(skill.tags, []),
        prerequisites: prereqs,
        unlocks,
        mastery,
      };
    },
  },

  /* ------------------------------------------------------------ interface -- */
  {
    name: 'save_interface',
    description:
      'Save an interface you just wrote and get a URL to open it. This is how the child ' +
      'actually meets your work.\n\n' +
      'Write a complete standalone HTML document. No build step, no CDN, no external requests — ' +
      'inline all CSS and JS. A global `primer` object is injected for you:\n' +
      '  primer.mark()                        // start timing an item\n' +
      '  primer.observe({skill, correct, item, response, expected, hints, modality})\n' +
      '  primer.affect("frustration", {intensity, evidence})\n' +
      '  primer.interest("dinosaurs")\n' +
      '  primer.misconception("reads every vowel as short", {skill})\n' +
      '  primer.done({summary, energy})       // call when the activity is finished\n\n' +
      'Every attempt you report flows straight back into the record, so the next session ' +
      'starts from what actually happened in this one. An interface that reports nothing ' +
      'teaches the record nothing.\n\n' +
      'Honor every accommodation from learner_context. Build it around their interests. ' +
      'Do not reach for a generic quiz layout — look at what has worked for this child before.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        title: str('What this is, in plain words. Shown to adults, not necessarily the child.'),
        html: str('Complete standalone HTML document.'),
        kind: str('game | drill | story | canvas | manipulative | reader | quiz | other'),
        target_skills: { type: 'array', items: { type: 'string' }, description: 'Skill ids this targets.' },
        spec: {
          type: 'object',
          description:
            'Your design decisions: why this shape, which interests it uses, which ' +
            'accommodations it honors, what you would change next time. Future sessions read this.',
        },
      },
      ['learner', 'title', 'html'],
    ),
    handler: (a, ctx) => {
      const learner = resolveLearner(a.learner);

      // Checked before it can be saved, let alone queued. A child running this
      // has no console and no way to tell anyone it broke.
      //
      // The accommodations go in because SPEC.md calls honoring them a hard
      // constraint, and a constraint the validator cannot see is a constraint
      // enforced by the tutor remembering. Anything it cannot establish from
      // the source comes back as unverifiable rather than as a pass.
      const check = validateInterface(a.html ?? '', {
        accommodations: accommodations(learner.id),
      });
      if (!check.ok) {
        return {
          saved: false,
          problems: check.errors,
          message: explain(check),
        };
      }

      const iface = saveInterface(learner.id, {
        title: a.title,
        html: a.html,
        kind: a.kind,
        spec: a.spec,
        target_skills: a.target_skills,
      });
      return {
        saved: true,
        interface_id: iface.id,
        url: `${ctx.origin}/i/${iface.id}`,
        warnings: check.warnings.length ? check.warnings : undefined,
        next: 'Call plan_activity with this interface_id so the child actually meets it.',
      };
    },
  },
  {
    name: 'list_interfaces',
    description:
      'Interfaces you have built for this child, newest first, with how they scored. ' +
      'Read the specs before designing something new — reuse what reached them.',
    inputSchema: obj({ learner: str('Learner id or name.'), limit: num('Default 20.') }, ['learner']),
    handler: (a, ctx) => {
      const learner = resolveLearner(a.learner);
      return listInterfaces(learner.id, a.limit ?? 20).map((i) => ({
        id: i.id,
        title: i.title,
        kind: i.kind,
        url: `${ctx.origin}/i/${i.id}`,
        created_at: i.created_at,
        times_used: i.times_used,
        outcome_score: i.outcome_score,
        outcome_note: i.outcome_note,
        target_skills: parseJson<string[]>(i.target_skills, []),
        spec: parseJson<unknown>(i.spec, null),
      }));
    },
  },
  {
    name: 'get_interface_html',
    description: 'Read back the source of an interface you built, so you can revise rather than restart.',
    inputSchema: obj({ interface_id: str('Interface id.') }, ['interface_id']),
    handler: (a) => {
      const iface = getInterface(a.interface_id);
      if (!iface) throw new Error(`No interface "${a.interface_id}"`);
      return { id: iface.id, title: iface.title, html: readInterfaceHtml(iface) };
    },
  },
  {
    name: 'score_interface',
    description:
      'Rate how an interface actually went, from the evidence inside it. Called automatically ' +
      'when a session ends; call it directly if you closed things out yourself.',
    inputSchema: obj({ interface_id: str('Interface id.'), note: str('What worked, what did not.') }, [
      'interface_id',
    ]),
    handler: (a) => ({ outcome_score: scoreInterface(a.interface_id, a.note) }),
  },

  /* ---------------------------------------------------------------- queue -- */
  {
    name: 'plan_activity',
    description:
      'Queue an interface for the child to meet next. Call this after save_interface for ' +
      'anything you want them to actually do — an interface that is never queued is never seen. ' +
      'Write the rationale for the adult who reviews it: what it targets, why now, and what you ' +
      'expect to learn from how it goes. If review is required on this install, the activity ' +
      'waits for a parent before the child can reach it.',
    inputSchema: obj(
      {
        learner: str('Learner id or display name.'),
        interface_id: str('From save_interface.'),
        title: str('Plain words. An adult reads this, not the child.'),
        rationale: str('Why this, why now. Name the rows in the record behind the decision.'),
        target_skills: { type: 'array', items: { type: 'string' } },
      },
      ['learner', 'interface_id', 'title'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return describeActivity(
        planActivity(learner.id, {
          interface_id: a.interface_id,
          title: a.title,
          rationale: a.rationale,
          target_skills: a.target_skills,
        }),
      );
    },
  },
  {
    name: 'queue_status',
    description:
      'What is already waiting for this child, and what an adult said about your past plans. ' +
      'Read it before planning: do not queue a fourth activity when three sit untouched, and do ' +
      'not rebuild something a parent already rejected.',
    inputSchema: obj({ learner: str('Learner id or display name.') }, ['learner']),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return {
        ready: readyCount(learner.id),
        queued: queue(learner.id).map(describeActivity),
        adult_feedback_on_past_plans: recentReviewFeedback(learner.id),
      };
    },
  },

  /* ------------------------------------------------------------ artifacts -- */
  {
    name: 'list_artifacts',
    description:
      "Recordings and work products the child has produced — audio of them reading, " +
      'photos of handwriting, drawings. You cannot hear or see these. What you get is ' +
      'that they exist, when, what they were asked to do, how long it ran, and any ' +
      'transcript or note a human added after listening.\n\n' +
      'Use them two ways: build activities that ask the child to read aloud when fluency ' +
      'is what you need to know (taps cannot measure phrasing or self-correction), and ' +
      'ask an adult to listen when a recording would settle a question the record cannot.',
    inputSchema: obj({ learner: str('Learner id or name.'), limit: num('Default 20.') }, ['learner']),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return {
        audio_capture_enabled: settings().audio_capture,
        artifacts: listArtifacts(learner.id, a.limit ?? 20).map(describeArtifact),
        note: settings().audio_capture
          ? 'Call primer.listen({prompt, skill}) inside an interface to record.'
          : 'Recording is switched off on this install. An adult must turn it on; do not ' +
            'build an activity that depends on it, and do not ask them to enable it unless ' +
            'there is a specific question only hearing the child would answer.',
      };
    },
  },
  {
    name: 'record_artifact_review',
    description:
      'Write down what a human heard or saw in a recording, and mark it reviewed. Use ' +
      'this after an adult tells you about a clip — their judgment becomes evidence in ' +
      'the record like any other observation.',
    inputSchema: obj(
      {
        learner: str('Learner id or name.'),
        artifact_id: str('From list_artifacts.'),
        transcript: str('What the child actually said, if known. Verbatim.'),
        note: str('What it showed. Be specific: phrasing, self-corrections, hesitation.'),
        skill_id: str('Skill this is evidence about, if any.'),
        correct: num('1, 0, or a fraction, if this is gradeable evidence.'),
      },
      ['learner', 'artifact_id'],
    ),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      markReviewed(a.artifact_id, 'tutor:claude', {
        transcript: a.transcript,
        caption: a.note,
      });
      if (a.skill_id) {
        recordObservations(learner.id, [
          {
            skill_id: a.skill_id,
            kind: 'artifact_review',
            correct: a.correct ?? null,
            item: `recording ${a.artifact_id}`,
            response: a.transcript ?? a.note ?? null,
            modality: 'spoken',
            source: a.artifact_id,
          },
        ]);
      }
      return { ok: true, artifact_id: a.artifact_id };
    },
  },

  /* -------------------------------------------------------------- reports -- */
  {
    name: 'progress_report',
    description:
      'Structured summary for a parent conversation: what was mastered, what is in flight, ' +
      'what needs a different approach, how much time, how it felt. Returns data — you write the prose.',
    inputSchema: obj({ learner: str('Learner id or name.'), days: num('Window, default 30.') }, ['learner']),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return progressReport(learner.id, a.days ?? 30);
    },
  },
  {
    name: 'export_record',
    description:
      'The entire record as JSON — every observation, every session, every interface. ' +
      'The family owns this and can take it anywhere.',
    inputSchema: obj({ learner: str('Learner id or name.') }, ['learner']),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      logEvent('tutor:claude', 'export_record', learner.id);
      return exportRecord(learner.id);
    },
  },
  {
    name: 'recompute_mastery',
    description:
      'Rebuild every mastery estimate from raw observations. Safe to run any time — evidence ' +
      'is the source of truth and estimates are only a cache.',
    inputSchema: obj({ learner: str('Learner id or name.') }, ['learner']),
    handler: (a) => {
      const learner = resolveLearner(a.learner);
      return { skills_recomputed: recompute(learner.id) };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
