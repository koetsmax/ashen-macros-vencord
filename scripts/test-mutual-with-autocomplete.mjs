#!/usr/bin/env node
/**
 * Regression: mutual "with" autocomplete must pick the line owner, not the partner.
 * Mirrors scoreQueueMemberChoice / pick logic in actions.ts (display-name labels).
 */

function queueLineOwnerSegment(choiceName) {
  const m = String(choiceName ?? "").match(/^\s*\d+\s*:\s*(.+?)(?:\s*--|\s*$)/);
  return (m?.[1] ?? "").trim();
}

function queueLineOwnerId(choiceName) {
  const seg = queueLineOwnerSegment(choiceName);
  const segMention = seg.match(/<@!?(\d{16,20})>/);
  if (segMention) return segMention[1];
  const raw = seg.match(/^(\d{16,20})\b/);
  if (raw) return raw[1];
  const any = String(choiceName ?? "").match(/<@!?(\d{16,20})>/);
  return any?.[1] ?? null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownerSegmentMatches(segment, queryId, hints) {
  const seg = String(segment ?? "");
  if (!seg) return false;
  if (seg.includes(`<@${queryId}>`) || seg.includes(`<@!${queryId}>`)) return true;
  if (new RegExp(`(^|\\s)${escapeRegExp(queryId)}(\\s|$)`).test(seg)) return true;
  const cleaned = seg.replace(/^@+/, "").trim().toLowerCase();
  for (const h of hints) {
    if (!h || h.length < 2) continue;
    if (cleaned === h || cleaned.startsWith(`${h} `)) return true;
    if (new RegExp(`(^|\\s|@)${escapeRegExp(h)}(\\s|$|,)`, "i").test(seg)) return true;
  }
  return false;
}

function scoreQueueMemberChoice(choice, queryId, hints) {
  const name = String(choice.name ?? "");
  if (queueLineOwnerId(name) === queryId) return 100;
  if (ownerSegmentMatches(queueLineOwnerSegment(name), queryId, hints)) return 90;
  const lower = name.toLowerCase();
  if (lower.includes(queryId)) return 10;
  if (hints.some(h => h.length >= 3 && lower.includes(h))) return 10;
  return 0;
}

function pick(choices, query, matchHint) {
  const q = String(query).trim().toLowerCase();
  const hints = matchHint ? [String(matchHint).toLowerCase()] : [];
  const ranked = choices
    .map(c => ({ c, score: scoreQueueMemberChoice(c, q, hints) }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > 0) return ranked[0].c;
  return choices[0];
}

const SWOUKII = "111111111111111111";
const KZ = "222222222222222222";

const mutualDisplay = [
  { name: "1: Kz -- Anything: with @swoukii", value: "uuid-kz" },
  { name: "2: swoukii -- Anything: with @Kz", value: "uuid-swoukii" },
];

const mutualMentions = [
  { name: `1: <@${KZ}> -- Anything: with <@${SWOUKII}>`, value: "uuid-kz" },
  { name: `2: <@${SWOUKII}> -- Anything: with <@${KZ}>`, value: "uuid-swoukii" },
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  pick(mutualDisplay, SWOUKII, "swoukii").value === "uuid-swoukii",
  "display labels: process swoukii must not pick Kz (listed first)"
);
assert(
  pick(mutualDisplay, KZ, "Kz").value === "uuid-kz",
  "display labels: process Kz must pick Kz"
);
assert(
  pick(mutualMentions, SWOUKII).value === "uuid-swoukii",
  "mention labels: process swoukii"
);
assert(
  pick(mutualMentions, KZ).value === "uuid-kz",
  "mention labels: process Kz"
);

// Old bug: longest-includes / choices[0] would pick Kz when processing swoukii
assert(mutualDisplay[0].value === "uuid-kz", "fixture: Kz is first choice");
assert(
  pick(mutualDisplay, SWOUKII, "swoukii").value !== mutualDisplay[0].value,
  "must not fall back to choices[0] for mutual with"
);

console.log("ok  mutual-with autocomplete pick");
