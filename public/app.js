const form = document.getElementById('topicForm');
const topicInput = document.getElementById('topic');
const results = document.getElementById('results');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const topic = topicInput.value.trim();
  if (!topic) return;
  results.innerHTML = '<p class="loading">Running council...</p>';

  try {
    const res = await fetch('/api/discuss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic })
    });

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      const message = contentType.includes('application/json')
        ? ((await res.json()).error || `Request failed with status ${res.status}`)
        : `Request failed with status ${res.status}`;
      throw new Error(message);
    }

    if (!contentType.includes('application/json')) {
      throw new Error('Unexpected response format from server');
    }

    const data = await res.json();
    renderResults(data);
  } catch (err) {
    results.innerHTML = `<div class="error">Error: ${escapeHtml(err.message)}</div>`;
  }
});

function renderResults(data) {
  if (data.error) {
    results.innerHTML = `<div class="error">${escapeHtml(data.error)}</div>`;
    return;
  }

  const cards = (Array.isArray(data.contributions) ? data.contributions : []).map((c, idx) => {
    const answer = c.answer || c.reasoning || 'No answer';
    const confidence = Number.isFinite(Number(c.confidence)) ? `${Math.round(Number(c.confidence))}% confidence` : '';
    const squadDetails = c.squad
      ? `<p><strong>QB:</strong> ${escapeHtml(c.squad.qb || '-')}<br /><strong>Offense:</strong> ${escapeHtml(c.squad.offenseTeam || '-')}<br /><strong>Defense:</strong> ${escapeHtml(c.squad.defenseTeam || '-')}</p>`
      : '';
    return `
      <article class="answer-card">
        <div class="card-head">
          <span class="card-index">Answer ${idx + 1}</span>
          <span class="confidence">${escapeHtml(confidence)}</span>
        </div>
        <h3>${escapeHtml(c.agent || `Perspective ${idx + 1}`)}</h3>
        <p class="answer-value">${escapeHtml(answer)}</p>
        ${squadDetails}
        <p>${renderRichText(c.reasoning || '')}</p>
      </article>
    `;
  }).join('');

  results.innerHTML = `
    <section class="summary-card">
      <p class="topic-label">Topic</p>
      <h2>${escapeHtml(data.topic)}</h2>
      <div class="verdict-row">
        <span class="verdict-chip">Final Answer</span>
      </div>
      <p class="verdict-answer">${escapeHtml(data.verdict || 'No verdict')}</p>
      <p class="verdict-reason">${renderRichText(data.verdictReasoning || 'No verdict reasoning provided.')}</p>
    </section>

    <section class="answers-grid">
      ${cards}
    </section>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderRichText(s) {
  return escapeHtml(s).replace(/\n/g, '<br />');
}
