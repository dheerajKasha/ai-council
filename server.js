require('dotenv').config();
const express = require('express');
const path = require('path');
const orchestrator = require('./orchestrator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/discuss', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  try {
    const result = await orchestrator.discuss(topic);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Council server listening on http://localhost:${PORT}`);
});
