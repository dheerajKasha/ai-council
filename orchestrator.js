const agents = require('./agents');

function normalizeTopic(topic) {
  return String(topic || '').trim();
}

function getMode() {
  return String(process.env.MODE || 'local').toLowerCase().trim();
}

function isSquadQuery(topic) {
  const t = topic.toLowerCase();
  return t.includes('squad') || t.includes('lineup') || t.includes('starting') || t.includes('best nfl');
}

function isNflQuery(topic) {
  const t = topic.toLowerCase();
  return t.includes('nfl') || t.includes('football') || t.includes('super bowl') || isSquadQuery(t);
}

function buildSquadAnswer(agent, answerName, qb, offenseTeam, defenseTeam, justification, confidence) {
  return {
    agent,
    answer: answerName,
    squad: {
      qb,
      offenseTeam,
      defenseTeam,
      justification
    },
    reasoning: justification,
    confidence
  };
}

function localNflContributions(topic) {
  return [
    buildSquadAnswer(
      'Performance Scout',
      'Championship Stability Squad',
      'Patrick Mahomes',
      'San Francisco 49ers offense',
      'Baltimore Ravens defense',
      `For "${topic}", this mix prioritizes elite quarterback decision-making under pressure, a modern offensive system with multiple coverage beaters, and a defense built to create negative plays. It balances stability with playoff-proven execution, so the floor stays high in close games. It is also the least matchup-sensitive of the three options, which matters over a full season.`,
      88
    ),
    buildSquadAnswer(
      'Roster Analyst',
      'Two-Way Balance Squad',
      'Lamar Jackson',
      'Miami Dolphins offense',
      'Cleveland Browns defense',
      `For "${topic}", this setup maximizes explosive-play pressure through speed and space usage while pairing it with a high-disruption defensive front. The profile is ideal when the goal is to overwhelm opponents with tempo shifts and early scoring runs. The tradeoff is slightly higher week-to-week variance compared with the top pick.`,
      83
    ),
    buildSquadAnswer(
      'Ceiling Analyst',
      'High-Upside Efficiency Squad',
      'Josh Allen',
      'Detroit Lions offense',
      'Kansas City Chiefs defense',
      `For "${topic}", this choice targets top-end scoring output with a complementary defense that can survive high-volume passing games. It is a ceiling-oriented construction, valuable when upside matters more than consistency. The downside is greater dependence on game-script control and health continuity.`,
      81
    )
  ];
}

function localGenericContributions(topic) {
  return [
    {
      agent: 'Strategic Architect',
      answer: `Outcome-first strategy for ${topic}`,
      reasoning: `Primary recommendation: anchor "${topic}" to a clear business or performance outcome before choosing tools or process details. Define success metrics, decision rights, and owner accountability in week one, then run a contained pilot to produce measurable evidence. This path tends to create the best long-term durability because expansion decisions are based on validated results rather than momentum.`,
      confidence: 82
    },
    {
      agent: 'Execution Operator',
      answer: `Speed-optimized rollout for ${topic}`,
      reasoning: `Secondary recommendation: prioritize fast implementation with strict operating guardrails so value arrives early. Use short cycles, weekly checkpoints, and rollback thresholds to prevent small failures from compounding. This approach wins when time-to-value is critical, but requires strong incident response discipline.`,
      confidence: 77
    },
    {
      agent: 'Risk Controller',
      answer: `Control-first model for ${topic}`,
      reasoning: `Conservative recommendation: build governance, compliance, and reliability standards before scaling usage. Front-load policy boundaries, quality gates, and ownership handoffs so operational risk remains bounded as adoption grows. This route is slower initially, but it produces cleaner auditability and fewer downstream reversals.`,
      confidence: 79
    }
  ];
}

function formatSquadLabel(squad) {
  if (!squad) return '';
  return `QB: ${squad.qb} | Offense: ${squad.offenseTeam} | Defense: ${squad.defenseTeam}`;
}

function pickVerdict(contributions, topic) {
  const sorted = [...contributions].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const winner = sorted[0] || { answer: 'No clear answer', reasoning: 'No contributions available.' };

  const hasSquad = Boolean(winner.squad && winner.squad.qb);
  const alternatives = sorted.slice(1).map(c => c.squad ? formatSquadLabel(c.squad) : c.answer).join(' | ');

  if (hasSquad) {
    const verdict = formatSquadLabel(winner.squad);
    return {
      verdict,
      verdictSquad: winner.squad,
      verdictReasoning: `Selected final squad for "${topic}": ${verdict}. This option was chosen because it delivers the strongest blend of baseline consistency, matchup resilience, and late-stage execution quality across the three submissions. It also had the highest confidence score while maintaining fewer structural weaknesses than the alternatives. Alternatives considered: ${alternatives || 'none'}.`
    };
  }

  return {
    verdict: winner.answer,
    verdictReasoning: `Selected "${winner.answer}" as final answer for "${topic}" because it produced the strongest combined case on expected impact, execution feasibility, and risk-adjusted durability. Compared to the other two answers, it offered clearer operational sequencing and fewer hidden dependencies, which improves decision reliability. Alternatives considered: ${alternatives || 'none'}.`
  };
}

function parseJsonBlock(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
}

function normalizeLlmContribution(agentName, rawText, fallbackTopic, squadQuery) {
  const parsed = parseJsonBlock(rawText);
  let confidence = parsed && Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 60;
  confidence = Math.max(1, Math.min(99, Math.round(confidence)));

  if (squadQuery) {
    const squad = parsed && parsed.squad && typeof parsed.squad === 'object' ? parsed.squad : {};
    const qb = String(squad.qb || parsed?.qb || 'Unknown QB');
    const offenseTeam = String(squad.offenseTeam || parsed?.offenseTeam || parsed?.offense || 'Unknown offense');
    const defenseTeam = String(squad.defenseTeam || parsed?.defenseTeam || parsed?.defense || 'Unknown defense');
    const justification = String(parsed?.justification || parsed?.reasoning || `Generated squad perspective for "${fallbackTopic}".`);
    return {
      agent: agentName,
      answer: `${qb} + ${offenseTeam} + ${defenseTeam}`,
      squad: { qb, offenseTeam, defenseTeam, justification },
      reasoning: justification,
      confidence
    };
  }

  const answer = parsed && parsed.answer
    ? String(parsed.answer)
    : String(rawText || `No clear answer from ${agentName}`).split(/\n+/)[0].slice(0, 180);
  const reasoning = parsed && parsed.reasoning
    ? String(parsed.reasoning)
    : `Generated perspective for "${fallbackTopic}".`;

  return {
    agent: agentName,
    answer,
    reasoning,
    confidence
  };
}

async function discussWithLLM(topic, options = {}) {
  const participants = options.participants && options.participants.length
    ? options.participants
    : agents.getAgentNames().slice(0, 3);

  const squadQuery = isNflQuery(topic) && isSquadQuery(topic);

  const runs = participants.map(name => {
    const content = squadQuery
      ? `Topic: "${topic}"\nReturn JSON only with this schema: {"answer":"short label","squad":{"qb":"...","offenseTeam":"...","defenseTeam":"...","justification":"..."},"confidence":<1-99>}.`
      : `Topic: "${topic}"\nReturn JSON only: {"answer":"...","reasoning":"...","confidence":<1-99>}.`;

    const messages = [
      { role: 'system', content: `You are ${name}. Provide concise, concrete answers.` },
      { role: 'user', content }
    ];

    return agents.runAgent(name, topic, { messages });
  });

  const raw = await Promise.all(runs);
  const contributions = raw.map(r => normalizeLlmContribution(r.agent, r.reasoning, topic, squadQuery));
  const { verdict, verdictReasoning, verdictSquad } = pickVerdict(contributions, topic);

  return {
    topic,
    verdict,
    verdictSquad,
    verdictReasoning,
    contributions,
    decider: {
      agent: 'Council Moderator',
      answer: verdict,
      reasoning: verdictReasoning
    }
  };
}

async function discuss(topic, options = {}) {
  const normalizedTopic = normalizeTopic(topic);

  if (getMode() === 'llm') {
    return discussWithLLM(normalizedTopic, options);
  }

  const contributions = isNflQuery(normalizedTopic)
    ? localNflContributions(normalizedTopic)
    : localGenericContributions(normalizedTopic);

  const { verdict, verdictReasoning, verdictSquad } = pickVerdict(contributions, normalizedTopic);

  return {
    topic: normalizedTopic,
    verdict,
    verdictSquad,
    verdictReasoning,
    contributions,
    decider: {
      agent: 'Council Moderator',
      answer: verdict,
      reasoning: verdictReasoning
    }
  };
}

module.exports = { discuss };
