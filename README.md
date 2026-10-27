# Twwinz.com | Creator AI Twin Platform

A turnkey, edge-native platform running on **Cloudflare Workers** & **SQLite D1**, integrated with **GoHighLevel (GHL)** for CRM/lead capture and chat widget delivery.

## Key Features

1. **Private RAG & Zero-Hallucination Grounding**:
   - Celebrities and creators input unindexed information (tour dates, secret appearances, exclusive Cameo/merch discount codes, gear lists, and persona guidelines).
   - Hybrid full-text search (SQLite FTS5) + semantic retrieval pulls verified facts into the prompt dynamically before answering fans.
2. **GoHighLevel (GHL) Automated Provisioning**:
   - Automatically provisions a dedicated GHL Sub-Account (Location) via the GHL Agency API (`POST /locations/`) upon signup.
   - Deploys pre-built website snapshots if the creator does not have a website.
   - Routes inbound fan messages from GHL Chat Widgets through Cloudflare Workers to the RAG engine, responding back via the GHL Conversations API (`POST /conversations/messages`).
3. **Automated Brand Aesthetic Scraper**:
   - When a celebrity inputs their existing website URL (e.g. `https://creator.com`), the style scraper analyzes the page's HTML, CSS variables, and Google Fonts to automatically extract:
     - Primary and accent brand colors
     - Heading and body fonts
     - Favicon and page metadata
   - Dynamically customizes the chat widget styling to blend seamlessly into their existing site.
4. **Creator Control Center (`dashboard.html`)**:
   - Manage grounded facts across categories: Tour Dates, Exclusive Offers, FAQs, and Bio.
   - Live Interactive Grounded Sandbox to test answers and view verified sources in real time.
   - 1-click embed code generator snippet ready for WordPress, Squarespace, Wix, Shopify, or Webflow.

---

## Architecture Overview

```
                               ┌────────────────────────────────┐
                               │       CELEBRITY ONBOARDING     │
                               │         (onboard.html)         │
                               └───────────────┬────────────────┘
                                               │
                                               ▼
┌───────────────────────┐            ┌───────────────────┐            ┌────────────────────────┐
│   GoHighLevel (GHL)   │            │ Cloudflare Worker │            │  Cloudflare D1 (SQLite)│
│ - Sub-Account / Loc   │◄───────────┤   (src/worker.js) ├───────────►│ - creators             │
│ - Chat Widget Styling │ (API Sync) └─────────┬─────────┘ (Relational│ - knowledge_items (FTS)│
│ - Conversation CRM    │                      │             & Ground)│ - chat_sessions        │
└───────────┬───────────┘                      │                      └────────────────────────┘
            │                                  ▼
            │ (Inbound Webhook)     ┌─────────────────────┐
            └──────────────────────►│  RAG Memory Engine  │
                                    │ (src/services/rag)  │
                                    └─────────────────────┘
```

---

## Project Structure

```
├── .assetsignore             # Files excluded from static deployment
├── wrangler.jsonc            # Cloudflare Worker & D1 binding configuration
├── schema.sql                # SQLite D1 database schema with FTS5
├── seed.sql                  # Realistic demo data (Jaxson Reed)
├── package.json              # NPM scripts for local development
├── index.html                # Landing page with embedded twin widget
├── onboard.html              # 3-step creator onboarding wizard
├── dashboard.html            # Creator Control Center & RAG manager
├── widget.js                 # Embeddable, themeable chat widget script
└── src/
    ├── worker.js             # Cloudflare Worker API router
    └── services/
        ├── styleScraper.js   # Scrapes brand colors & fonts from websites
        ├── ghlService.js     # GoHighLevel API integration
        └── ragEngine.js      # Dynamic grounding & LLM persona generator
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Healthcheck & D1 database connectivity status |
| `POST` | `/api/creators/signup` | Registers creator, scrapes site, provisions GHL sub-account |
| `GET` | `/api/creators` | List creators or query by `?id=` or `?slug=` |
| `PUT` | `/api/creators/:id` | Update creator profile, persona prompt, or brand colors |
| `GET` | `/api/creators/:id/knowledge` | Fetch all grounded RAG items (filter with `?category=`) |
| `POST` | `/api/creators/:id/knowledge` | Add new unindexed fact (schedule, offer, FAQ, bio) |
| `DELETE` | `/api/creators/:id/knowledge/:itemId` | Remove grounded fact from D1 |
| `GET` | `/api/creators/:id/embed` | Generates 1-line HTML embed snippet |
| `POST` | `/api/utils/scrape-styles` | Scrapes brand colors, Google fonts & logo from any URL |
| `POST` | `/api/chat/preview` | Sandbox RAG query tester returning grounded sources |
| `POST` | `/api/chat/ghl-webhook` | Inbound webhook receiver for GoHighLevel chat messages |

---

## Local Development

### 1. Initialize & Seed Database
```bash
npm run db:init
npm run db:seed
```

### 2. Start Local Cloudflare Dev Server
```bash
npm run dev
```
Open [http://localhost:8787](http://localhost:8787) in your browser:
- Landing Page: `http://localhost:8787/index.html`
- Creator Onboarding: `http://localhost:8787/onboard.html`
- Creator Control Center: `http://localhost:8787/dashboard.html`

### 3. Environment Variables (Optional for Live Production)
Set in `.dev.vars` (or via Cloudflare Dashboard / `wrangler secret put`):
- `GHL_AGENCY_API_KEY`: Your GoHighLevel Agency API key (v2)
- `GHL_CREATOR_SNAPSHOT_ID`: Snapshot template ID to deploy for new websites
- `OPENAI_API_KEY`: OpenAI API key (for `gpt-4o-mini` generation)
