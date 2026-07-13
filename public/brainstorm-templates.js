// Brainstorm starter templates. Each template pairs a session intent (what the
// agent should steer toward) with a canvas skeleton (labeled zones the agent
// fills as the conversation happens). These are the five session shapes the
// product is optimized for: product brainstorming, campaign planning, team
// strategy, organizational efficiency, and team retros.
//
// Elements are Excalidraw skeletons expanded client-side via
// convertToExcalidrawElements(..., { regenerateIds: false }) - same pattern as
// starter-elements.js. Every id carries TEMPLATE_ELEMENT_ID_PREFIX so the
// setup screen can swap skeletons when the user switches templates without
// touching anything the user drew themselves. Zone boxes never use bound
// labels (they clip); headers and hints are explicit text elements.

export const TEMPLATE_ELEMENT_ID_PREFIX = "tpl-";

export function isTemplateElementId(id) {
  return typeof id === "string" && id.startsWith(TEMPLATE_ELEMENT_ID_PREFIX);
}

const INK = "#1e1e1e";
const HINT_INK = "#868e96";

// Rough width reservation for Excalidraw's handwritten font (fontFamily 1) so
// text never renders clipped. Generous on purpose.
function textWidth(text, fontSize) {
  const longest = Math.max(...text.split("\n").map((line) => line.length));
  return Math.ceil(longest * fontSize * 1.0);
}

function textEl(id, x, y, text, fontSize, strokeColor = INK) {
  const lines = text.split("\n").length;
  return {
    type: "text",
    id,
    x,
    y,
    width: textWidth(text, fontSize),
    height: Math.ceil(fontSize * 1.25 * lines),
    text,
    fontSize,
    fontFamily: 1,
    strokeColor,
  };
}

// A zone: tinted rounded box + header + a faint prompt inside. The prompt
// doubles as a cue to the agent (it reads the canvas snapshot) and to the
// people in the room about what belongs where.
function zone(templateId, key, { x, y, w, h, title, hint, color }) {
  const idBase = `${TEMPLATE_ELEMENT_ID_PREFIX}${templateId}-${key}`;
  const elements = [
    {
      type: "rectangle",
      id: `${idBase}-box`,
      x,
      y,
      width: w,
      height: h,
      backgroundColor: color,
      fillStyle: "solid",
      strokeColor: "#adb5bd",
      roundness: { type: 3 },
    },
    textEl(`${idBase}-head`, x + 18, y + 14, title, 20),
  ];
  if (hint) elements.push(textEl(`${idBase}-hint`, x + 18, y + 48, hint, 13, HINT_INK));
  return elements;
}

function title(templateId, text) {
  return textEl(`${TEMPLATE_ELEMENT_ID_PREFIX}${templateId}-title`, 60, 40, text, 30);
}

// Excalidraw pastel fills.
const YELLOW = "#fff3bf";
const GREEN = "#d3f9d8";
const BLUE = "#d0ebff";
const RED = "#ffe3e3";
const VIOLET = "#e5dbff";
const ORANGE = "#ffe8cc";
const GRAY = "#f1f3f5";

export const BRAINSTORM_TEMPLATES = [
  {
    id: "product-brainstorm",
    label: "Product brainstorm",
    tagline: "Problems → ideas → top bets",
    intent:
      "Product brainstorm: capture the user problems we're solving, generate a wide set of ideas, then converge on the top 3 bets by impact vs. effort - each with a concrete next step.",
    elements: [
      title("product-brainstorm", "Product brainstorm"),
      ...zone("product-brainstorm", "problems", { x: 60, y: 110, w: 360, h: 300, title: "Problems & user needs", hint: "Who hurts, and how badly?", color: RED }),
      ...zone("product-brainstorm", "ideas", { x: 450, y: 110, w: 520, h: 300, title: "Ideas", hint: "Quantity first. Wild ones welcome.", color: YELLOW }),
      ...zone("product-brainstorm", "bets", { x: 60, y: 440, w: 560, h: 240, title: "Top bets", hint: "High impact, low effort. Next step for each.", color: GREEN }),
      ...zone("product-brainstorm", "parking", { x: 650, y: 440, w: 320, h: 240, title: "Parking lot", hint: "Good, but not now.", color: GRAY }),
    ],
  },
  {
    id: "campaign-planning",
    label: "Campaign planning",
    tagline: "Objective → audience → channels → timeline",
    intent:
      "Plan a campaign end to end: lock the objective and its KPI, define the audience and the one key message, pick channels, and leave with a dated timeline and named owners.",
    elements: [
      title("campaign-planning", "Campaign plan"),
      ...zone("campaign-planning", "objective", { x: 60, y: 110, w: 440, h: 220, title: "Objective & KPI", hint: "One goal. One number that proves it.", color: ORANGE }),
      ...zone("campaign-planning", "audience", { x: 530, y: 110, w: 440, h: 220, title: "Audience & key message", hint: "Who, and the one thing they should remember.", color: BLUE }),
      ...zone("campaign-planning", "channels", { x: 60, y: 360, w: 440, h: 220, title: "Channels & assets", hint: "Where it runs, what we need to make.", color: VIOLET }),
      ...zone("campaign-planning", "timeline", { x: 530, y: 360, w: 440, h: 220, title: "Timeline & owners", hint: "Dates and names, or it isn't a plan.", color: GREEN }),
      ...zone("campaign-planning", "risks", { x: 60, y: 610, w: 910, h: 150, title: "Budget & risks", hint: "What it costs, what could sink it.", color: GRAY }),
    ],
  },
  {
    id: "team-strategy",
    label: "Team strategy",
    tagline: "Now → next 12 months → bets",
    intent:
      "Team strategy session: agree on where we are today, where we're going in the next 12 months, and the 3-5 bets that get us there - including what we deliberately won't do.",
    elements: [
      title("team-strategy", "Team strategy"),
      ...zone("team-strategy", "now", { x: 60, y: 110, w: 440, h: 250, title: "Where we are", hint: "Honest read: strengths, gaps, momentum.", color: BLUE }),
      ...zone("team-strategy", "vision", { x: 530, y: 110, w: 440, h: 250, title: "Where we're going (12 mo)", hint: "What's true a year from now if we win?", color: VIOLET }),
      ...zone("team-strategy", "bets", { x: 60, y: 390, w: 600, h: 260, title: "The bets (3-5)", hint: "The few moves that close the gap.", color: GREEN }),
      ...zone("team-strategy", "not-doing", { x: 690, y: 390, w: 280, h: 260, title: "Not doing", hint: "Strategy is what you say no to.", color: RED }),
    ],
  },
  {
    id: "org-efficiency",
    label: "Org efficiency",
    tagline: "Friction → root causes → fixes",
    intent:
      "Organizational efficiency review: surface what's slowing us down, dig into root causes rather than symptoms, and split fixes into quick wins vs. structural changes - with an owner on every fix.",
    elements: [
      title("org-efficiency", "Org efficiency"),
      ...zone("org-efficiency", "friction", { x: 60, y: 110, w: 440, h: 260, title: "What's slowing us down", hint: "Meetings, handoffs, waiting, rework...", color: RED }),
      ...zone("org-efficiency", "causes", { x: 530, y: 110, w: 440, h: 260, title: "Root causes", hint: "Ask why until it stops being a person.", color: ORANGE }),
      ...zone("org-efficiency", "quick", { x: 60, y: 400, w: 440, h: 250, title: "Quick wins (this month)", hint: "Cheap, fast, someone owns it.", color: GREEN }),
      ...zone("org-efficiency", "structural", { x: 530, y: 400, w: 440, h: 250, title: "Structural fixes", hint: "Bigger changes worth the disruption.", color: VIOLET }),
    ],
  },
  {
    id: "team-retro",
    label: "Team retro",
    tagline: "Went well → didn't → what changes",
    intent:
      "Team retro: capture what went well, what didn't, and the experiments worth trying - then converge on the few changes we'll actually commit to, each with an owner.",
    elements: [
      title("team-retro", "Retro"),
      ...zone("team-retro", "well", { x: 60, y: 110, w: 293, h: 300, title: "Went well", hint: "Keep doing this.", color: GREEN }),
      ...zone("team-retro", "poorly", { x: 373, y: 110, w: 293, h: 300, title: "Didn't go well", hint: "No blame. Just facts.", color: RED }),
      ...zone("team-retro", "ideas", { x: 686, y: 110, w: 293, h: 300, title: "Experiments", hint: "What might we try?", color: YELLOW }),
      ...zone("team-retro", "actions", { x: 60, y: 440, w: 919, h: 190, title: "Actions we commit to", hint: "Few, owned, and dated.", color: BLUE }),
    ],
  },
];
