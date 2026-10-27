/**
 * RAG Engine (Dynamic Grounding & Hybrid Semantic Search)
 * Combines Cloudflare Workers AI embeddings (@cf/baai/bge-base-en-v1.5)
 * with Cloudflare Vectorize and SQLite FTS5 full-text keyword search.
 */

export class RAGEngine {
  constructor(db, env) {
    this.db = db;
    this.env = env || {};
    this.openaiKey = this.env.OPENAI_API_KEY || null;
  }

  /**
   * Generates a 768-dimensional float embedding vector for text using
   * Cloudflare Workers AI, OpenAI, or local deterministic fallback.
   */
  async generateEmbedding(text) {
    const cleanText = (text || '').trim();
    if (!cleanText) return null;

    // 1. Cloudflare Workers AI Native Embedding
    if (this.env.AI) {
      try {
        const aiRes = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [cleanText]
        });
        if (aiRes && aiRes.data && aiRes.data[0]) {
          return aiRes.data[0];
        }
      } catch (err) {
        console.warn('[Workers AI Embedding Warning]', err.message);
      }
    }

    // 2. OpenAI Embedding Fallback
    if (this.openaiKey) {
      try {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.openaiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: cleanText
          })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.data && data.data[0]?.embedding) {
            return data.data[0].embedding;
          }
        }
      } catch (err) {
        console.warn('[OpenAI Embedding Warning]', err.message);
      }
    }

    // 3. Deterministic Local Normalized Embedding (for offline dev without API keys)
    return this.createDeterministicEmbedding(cleanText, 768);
  }

  /**
   * Creates a deterministic 768-dimensional float vector for local simulation
   */
  createDeterministicEmbedding(text, dimensions = 768) {
    const vec = new Array(dimensions).fill(0);
    const words = text.toLowerCase().split(/\s+/);
    
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash << 5) - hash + word.charCodeAt(i);
        hash |= 0;
      }
      const index = Math.abs(hash) % dimensions;
      vec[index] += 1;
    }

    // Normalize vector to unit length
    let norm = 0;
    for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) vec[i] /= norm;
    }
    return vec;
  }

  /**
   * Computes cosine similarity between two float vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Hybrid RAG Retrieval:
   * Merges Vector Semantic Search + SQLite FTS5 Keyword Search
   */
  async retrieveContext(creatorId, query) {
    const cleanQuery = (query || '').trim().toLowerCase();
    
    // 1. Generate Query Vector
    const queryVector = await this.generateEmbedding(cleanQuery);

    // 2. Fetch active knowledge items for this creator
    const { results: allItems } = await this.db.prepare(
      'SELECT * FROM knowledge_items WHERE creator_id = ? AND is_active = 1'
    ).bind(creatorId).all();

    if (!allItems || allItems.length === 0) {
      return [];
    }

    // 3. Run SQLite FTS5 Keyword Match
    const ftsMatchedIds = new Set();
    try {
      const ftsWords = cleanQuery.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
      if (ftsWords.length > 0) {
        const matchExpression = ftsWords.join(' OR ');
        const ftsQuery = `
          SELECT k.id FROM knowledge_items k
          JOIN knowledge_fts f ON k.id = f.id
          WHERE k.creator_id = ? AND k.is_active = 1 AND knowledge_fts MATCH ?
          LIMIT 10;
        `;
        const ftsRes = await this.db.prepare(ftsQuery).bind(creatorId, matchExpression).all();
        if (ftsRes.results) {
          ftsRes.results.forEach(r => ftsMatchedIds.add(r.id));
        }
      }
    } catch (e) {
      console.warn('[FTS Match Warning]', e.message);
    }

    // 4. Query Cloudflare Vectorize if bound
    const vectorizeMatchedScores = new Map();
    if (this.env.VECTORIZE && queryVector) {
      try {
        const vecMatches = await this.env.VECTORIZE.query(queryVector, {
          topK: 5,
          returnMetadata: true
        });
        if (vecMatches && vecMatches.matches) {
          for (const match of vecMatches.matches) {
            vectorizeMatchedScores.set(match.id, match.score || 0.8);
          }
        }
      } catch (vecErr) {
        console.warn('[Vectorize Query Warning]', vecErr.message);
      }
    }

    // 5. Score and Rank candidates
    const scoredItems = allItems.map(item => {
      let vectorScore = 0;

      // Check Vectorize score first
      if (vectorizeMatchedScores.has(item.id)) {
        vectorScore = vectorizeMatchedScores.get(item.id);
      } else if (item.embedding && queryVector) {
        // Calculate in-memory cosine similarity from D1 vector
        try {
          const itemVector = typeof item.embedding === 'string' ? JSON.parse(item.embedding) : item.embedding;
          vectorScore = this.cosineSimilarity(queryVector, itemVector);
        } catch (_) {}
      }

      // Keyword FTS match bonus
      const ftsScore = ftsMatchedIds.has(item.id) ? 1.0 : 0.0;
      
      // Category heuristics with word boundaries
      const isScheduleQuery = /\b(tour|concert|gig|dates?|convention|galaxycon|comic\s*con|appearances?|booths?|venues?)\b/i.test(cleanQuery);
      const isOfferQuery = /\b(merch|cameo|buy|discounts?|promos?|codes?|posters?|autographs?|prices?|costs?|shops?|shoutouts?)\b/i.test(cleanQuery);
      let categoryBonus = 0;
      if (isScheduleQuery && item.category === 'schedule') categoryBonus = 0.25;
      if (isOfferQuery && item.category === 'offer') categoryBonus = 0.25;

      // Combined Hybrid Score: prioritize semantic vector similarity and exact keyword matches
      const priorityBonus = (item.priority || 0) * 0.01;
      const combinedScore = (vectorScore * 0.6) + (ftsScore * 0.4) + categoryBonus + priorityBonus;

      return {
        ...item,
        vectorScore,
        ftsScore,
        combinedScore
      };
    });

    // Sort descending by combined score
    scoredItems.sort((a, b) => b.combinedScore - a.combinedScore);

    // Return top 5 most relevant grounded chunks
    return scoredItems.slice(0, 5);
  }

  /**
   * Synthesize the retrieved knowledge chunks into formatted grounding text
   */
  formatContextForPrompt(items) {
    if (!items || items.length === 0) {
      return "No specific private knowledge items found for this query.";
    }

    return items.map((item, idx) => {
      let metaStr = '';
      if (item.metadata) {
        try {
          const metaObj = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
          metaStr = ` | Details: ${JSON.stringify(metaObj)}`;
        } catch (_) {}
      }
      return `[Fact #${idx + 1}] (${item.category.toUpperCase()}) ${item.title}: ${item.content}${metaStr}`;
    }).join('\n\n');
  }

  /**
   * Generate grounded AI Twin response using OpenAI or Workers AI
   */
  async generateResponse({ creator, query, chatHistory = [] }) {
    // 1. Retrieve Grounded Context via Hybrid Vector + Keyword Search
    const knowledgeItems = await this.retrieveContext(creator.id, query);
    const formattedContext = this.formatContextForPrompt(knowledgeItems);

    const systemPrompt = `You are the official verified Digital Representative and AI Twin for ${creator.name}.
Persona & Tone Guidelines:
${creator.persona_prompt || 'Speak warmly, authentically, and conversationally in the first-person voice. Keep answers concise (2-3 sentences) unless the fan explicitly asks for detailed itinerary or stories.'}

CRITICAL GROUNDING RULES:
1. Below are UNINDEXED PRIVATE FACTS provided directly by ${creator.name} (schedules, secret discount codes, Cameo links, appearance booths, FAQs).
2. Answer the fan's query using ONLY these verified facts when relevant.
3. If the fan asks about upcoming dates, tickets, or purchases, provide the exact verified details from the facts.
4. DO NOT make up dates, unconfirmed projects, or private phone numbers.
5. If the answer is not in the private facts or general common knowledge about ${creator.name}, say you don't have that detail yet, and invite them to leave their email or check back!

=== VERIFIED PRIVATE FACTS ===
${formattedContext}
=== END PRIVATE FACTS ===
`;

    // 2. Call OpenAI if API key available
    if (this.openaiKey) {
      try {
        const messages = [
          { role: 'system', content: systemPrompt }
        ];

        for (const msg of chatHistory.slice(-4)) {
          messages.push({
            role: msg.sender === 'fan' ? 'user' : 'assistant',
            content: msg.message
          });
        }
        messages.push({ role: 'user', content: query });

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.openaiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.7,
            max_tokens: 300
          })
        });

        if (res.ok) {
          const data = await res.json();
          const reply = data.choices[0]?.message?.content?.trim();
          return {
            reply,
            ragSources: knowledgeItems.map(k => ({ id: k.id, title: k.title, category: k.category, score: k.combinedScore })),
            model: 'gpt-4o-mini'
          };
        }
      } catch (err) {
        console.error('[OpenAI Generation Error]', err);
      }
    }

    // 3. Call Cloudflare Workers AI if bound in env
    if (this.env.AI) {
      try {
        const aiMessages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ];
        const aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: aiMessages,
          max_tokens: 300
        });
        if (aiResponse && aiResponse.response) {
          return {
            reply: aiResponse.response.trim(),
            ragSources: knowledgeItems.map(k => ({ id: k.id, title: k.title, category: k.category, score: k.combinedScore })),
            model: 'llama-3.1-8b-instruct'
          };
        }
      } catch (err) {
        console.error('[Workers AI Error]', err);
      }
    }

    // 4. Intelligent Local Synthesizer Fallback
    let fallbackReply = '';
    if (knowledgeItems.length > 0) {
      const topFact = knowledgeItems[0];
      if (topFact.category === 'schedule') {
        fallbackReply = `Catch me in person! ${topFact.content}`;
      } else if (topFact.category === 'offer') {
        fallbackReply = `Here is something special for you: ${topFact.content}`;
      } else {
        fallbackReply = `${topFact.content}`;
      }
    } else {
      fallbackReply = `Hey! Thanks for reaching out. ${creator.name} hasn't uploaded specific details on that yet, but make sure to check out our upcoming tour dates and exclusive merch!`;
    }

    return {
      reply: fallbackReply,
      ragSources: knowledgeItems.map(k => ({ id: k.id, title: k.title, category: k.category, score: k.combinedScore })),
      model: 'twwinz-grounded-fallback'
    };
  }
}
