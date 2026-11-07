/**
 * RAG Engine (Dynamic Grounding & Hybrid Semantic Search)
 * Combines Cloudflare Workers AI embeddings (@cf/baai/bge-base-en-v1.5)
 * with Cloudflare Vectorize and SQLite FTS5 full-text keyword search.
 */

import { signMediaUrl } from './mediaService.js';

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
    const cleanText = (text || '').trim().slice(0, 4000);
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

      // Extract R2 key or image_url from metadata if present
      let imageUrl = null;
      if (item.metadata) {
        try {
          const metaObj = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
          if (metaObj && (metaObj.r2_key || metaObj.image_url)) {
            imageUrl = metaObj.r2_key ? `/api/media/${metaObj.r2_key}` : metaObj.image_url;
          }
        } catch (_) {}
      }
      
      // Category heuristics with word boundaries
      const isScheduleQuery = /\b(tour|concert|gig|dates?|convention|galaxycon|comic\s*con|appearances?|booths?|venues?|events?|podcasts?|bookings?)\b/i.test(cleanQuery);
      const isOfferQuery = /\b(merch|cameo|buy|discounts?|promos?|codes?|posters?|autographs?|prices?|costs?|shops?|shoutouts?|signed)\b/i.test(cleanQuery);
      const isPhotoQuery = /\b(pic|pics|picture|pictures|photo|photos|image|images|show\s+me|see|look\s+like)\b/i.test(cleanQuery);
      let categoryBonus = 0;
      if (isScheduleQuery && item.category === 'schedule') categoryBonus = 0.25;
      if (isOfferQuery && item.category === 'offer') categoryBonus = 0.25;
      if (isPhotoQuery && (item.category === 'photo' || imageUrl)) categoryBonus = 0.35;

      // Combined Hybrid Score: prioritize semantic vector similarity and exact keyword matches
      const priorityBonus = (item.priority || 0) * 0.01;
      const combinedScore = (vectorScore * 0.6) + (ftsScore * 0.4) + categoryBonus + priorityBonus;

      return {
        ...item,
        imageUrl,
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
          const cleanMeta = { ...metaObj };
          delete cleanMeta.image_url;
          delete cleanMeta.r2_key;
          if (Object.keys(cleanMeta).length > 0) {
            metaStr = ` | Details: ${JSON.stringify(cleanMeta)}`;
          }
        } catch (_) {}
      }
      const photoNote = item.imageUrl ? ` [Attached Photo "${item.title}" will be shown automatically in chat]` : '';
      return `[Fact #${idx + 1}] (${item.category.toUpperCase()}) ${item.title}: ${item.content.slice(0, 2500)}${photoNote}${metaStr}`;
    }).join('\n\n');
  }

  /**
   * Generate grounded AI Twin response using OpenAI or Workers AI
   */
  async generateResponse({ creator, query, chatHistory = [] }) {
    // 1. Retrieve Grounded Context via Hybrid Vector + Keyword Search
    const knowledgeItems = await this.retrieveContext(creator.id, query);
    const formattedContext = this.formatContextForPrompt(knowledgeItems);

    const isCasualGreeting = /^(hi|hey|hello|howdy|yo|sup|what'?s\s*up|how\s+are\s+you(\s+doing)?|good\s+(morning|afternoon|evening))[\s?!.]*$/i.test((query || '').trim());

    const systemPrompt = isCasualGreeting
      ? `You are the official verified AI Twin for ${creator.name}${creator.headline ? ` (${creator.headline})` : ''}.
Persona & Tone Guidelines:
${creator.persona_prompt || 'Speak warmly, authentically, and conversationally in the first-person voice.'}
The fan is greeting you or asking how you are. Reply warmly in 1-2 short, natural sentences in first-person voice as ${creator.name}, and invite them to ask about your upcoming convention appearances, signed merch, or booking inquiries.`
      : `You are the official verified Digital Representative and AI Twin for ${creator.name}${creator.headline ? ` (${creator.headline})` : ''}.
Persona & Tone Guidelines:
${creator.persona_prompt || 'Speak warmly, authentically, and conversationally in the first-person voice. Keep answers concise (2-3 sentences) unless the fan explicitly asks for detailed itinerary or stories.'}

CRITICAL GROUNDING & CONVERSATION RULES:
1. Speak in first-person ("I", "my") as ${creator.name}'s AI Twin. Answer ONLY what the fan actually asked in a natural, conversational 2-4 sentence response. NEVER copy-paste or dump the entire private facts block verbatim.
2. When the fan asks a specific question (e.g., about convention booths, dates, panels, signed merch, promo codes, or bookings), extract ONLY the specific facts that answer their question from the VERIFIED PRIVATE FACTS below.
3. DO NOT invent dates, prices, promo codes, or private phone numbers that are not in the verified facts.
4. If the fan's question isn't covered in the verified facts below, let them know you don't have that exact detail posted yet and invite them to leave their name and email in the chat so ${creator.name}'s team can follow up.

=== VERIFIED PRIVATE FACTS ===
${formattedContext}
=== END PRIVATE FACTS ===
`;

    const historyMessages = chatHistory.slice(-4).map(msg => ({
      role: msg.sender === 'fan' ? 'user' : 'assistant',
      content: String(msg.message || '')
    }));

    // 2. Call OpenAI if API key available
    if (this.openaiKey) {
      try {
        const messages = [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: query }
        ];

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.openaiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.65,
            max_tokens: 280
          })
        });

        if (res.ok) {
          const data = await res.json();
          const reply = data.choices[0]?.message?.content?.trim();
          if (reply) {
            return {
              reply,
              ragSources: isCasualGreeting ? [] : await this.formatSources(knowledgeItems, query),
              model: 'gpt-4o-mini'
            };
          }
        }
      } catch (err) {
        console.error('[OpenAI Generation Error]', err);
      }
    }

    // 3. Call Cloudflare Workers AI if bound in env
    if (this.env.AI) {
      const aiMessages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: query }
      ];

      const candidateModels = [
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/meta/llama-3.1-8b-instruct',
        '@cf/mistral/mistral-7b-instruct-v0.1'
      ];

      for (const modelName of candidateModels) {
        try {
          let aiResponse;
          try {
            aiResponse = await this.env.AI.run(modelName, {
              messages: aiMessages,
              max_tokens: 280
            });
          } catch (innerErr) {
            const errMsg = String(innerErr?.message || innerErr || '');
            if (errMsg.toLowerCase().includes('agree') || errMsg.toLowerCase().includes('license')) {
              await this.env.AI.run(modelName, { prompt: 'agree' }).catch(() => {});
              aiResponse = await this.env.AI.run(modelName, {
                messages: aiMessages,
                max_tokens: 280
              });
            } else {
              throw innerErr;
            }
          }

          const rawReply =
            (typeof aiResponse?.response === 'string' && aiResponse.response) ||
            aiResponse?.choices?.[0]?.message?.content ||
            '';
          const textReply = String(rawReply).trim();
          if (textReply) {
            return {
              reply: textReply,
              ragSources: isCasualGreeting ? [] : await this.formatSources(knowledgeItems, query),
              model: modelName.split('/').pop()
            };
          }
        } catch (err) {
          console.warn(`[Workers AI Warning: ${modelName}]`, err.message);
        }
      }
    }

    // 4. Intelligent Local Synthesizer Fallback (for offline tests without Workers AI binding)
    let fallbackReply = '';
    if (isCasualGreeting) {
      fallbackReply = `Doing great, thanks for asking! Welcome to ${creator.name}'s official AI Twin hub — feel free to ask me about upcoming appearances, signed merch, promo codes, or booking requests!`;
    } else if (knowledgeItems.length > 0) {
      const topFact = knowledgeItems[0];
      if (topFact.category === 'schedule') {
        fallbackReply = `Catch me in person! ${topFact.content}`;
      } else if (topFact.category === 'offer') {
        fallbackReply = `Here is something special for you: ${topFact.content}`;
      } else {
        fallbackReply = `${topFact.content}`;
      }
    } else {
      fallbackReply = `Hey! Thanks for reaching out. ${creator.name} hasn't uploaded specific details on that yet, but feel free to ask about upcoming appearances, signed merch, or booking inquiries!`;
    }

    return {
      reply: fallbackReply,
      ragSources: isCasualGreeting ? [] : await this.formatSources(knowledgeItems, query),
      model: 'twwinz-grounded-fallback'
    };
  }

  async formatSources(knowledgeItems, query = '') {
    const isPhotoQuery = /\b(pic|pics|picture|pictures|photo|photos|image|images|show\s+me|see|look\s+like)\b/i.test(query);
    return Promise.all(knowledgeItems.map(async (k, idx) => {
      const shouldIncludeImage = Boolean(k.imageUrl && (idx === 0 || isPhotoQuery || k.combinedScore >= 0.45));
      const signedImg = shouldIncludeImage ? await signMediaUrl(k.imageUrl, this.env) : null;
      return {
        id: k.id,
        title: k.title,
        category: k.category,
        score: k.combinedScore,
        imageUrl: signedImg
      };
    }));
  }
}
