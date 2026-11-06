/**
 * GoHighLevel (GHL) Integration Service
 * Manages Sub-Account (Location) Provisioning, Chat Widget Configuration,
 * Snapshot Template Deployment, and Inbound/Outbound Message Routing.
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

export class GHLService {
  constructor(env) {
    this.env = env || {};
    this.agencyKey = this.env.GHL_AGENCY_API_KEY || null;
    this.defaultSnapshotId = this.env.GHL_CREATOR_SNAPSHOT_ID || 'snap_celeb_default_site';
  }

  /**
   * Generate a strong HighLevel-compliant initial password (12+ chars, upper, lower, digit, symbol).
   */
  generateInitialSubAccountPassword() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `Tw!nz${token.slice(0, 6).toUpperCase()}${token.slice(6)}#9`;
  }

  /**
   * Ensure a password meets HighLevel's strict policy (12+ chars, upper, lower, digit, symbol).
   */
  normalizeGhlPassword(candidate) {
    if (!candidate) return this.generateInitialSubAccountPassword();
    const str = String(candidate);
    const hasUpper = /[A-Z]/.test(str);
    const hasLower = /[a-z]/.test(str);
    const hasDigit = /[0-9]/.test(str);
    const hasSymbol = /[^A-Za-z0-9]/.test(str);
    if (str.length >= 12 && hasUpper && hasLower && hasDigit && hasSymbol) {
      return str;
    }
    return `${str}Tw!9#aB2cD4e`.slice(0, Math.max(14, str.length + 5));
  }

  /**
   * Provision a Sub-Account Admin user (login email + password) scoped strictly to the newly created locationId.
   * POST https://services.leadconnectorhq.com/users/
   */
  async provisionSubAccountUser({ name, email, locationId, password }) {
    if (!email || !locationId) {
      return { success: false, error: 'email and locationId are required' };
    }

    const initialPassword = this.normalizeGhlPassword(password);
    const parts = String(name || 'Creator Official').trim().split(/\s+/);
    const firstName = parts[0] || 'Creator';
    const lastName = parts.slice(1).join(' ') || 'Official';

    if (!this.agencyKey) {
      return {
        success: true,
        isSimulated: true,
        userId: `usr_sim_${Date.now()}`,
        loginEmail: email,
        tempPassword: initialPassword
      };
    }

    try {
      const payload = {
        companyId: this.env.GHL_COMPANY_ID || undefined,
        firstName,
        lastName,
        email,
        password: initialPassword,
        type: 'account',
        role: 'admin',
        locationIds: [locationId]
      };

      const res = await fetch(`${GHL_API_BASE}/users/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.agencyKey}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn('[GHL provisionSubAccountUser Warning]', res.status, data.message || '');
        return {
          success: false,
          error: data.message || `HTTP ${res.status}`,
          loginEmail: email,
          tempPassword: initialPassword
        };
      }

      return {
        success: true,
        isSimulated: false,
        userId: data.id || data.userId || null,
        loginEmail: email,
        tempPassword: initialPassword
      };
    } catch (err) {
      console.warn('[GHL provisionSubAccountUser Error]', err.message);
      return {
        success: false,
        error: err.message,
        loginEmail: email,
        tempPassword: initialPassword
      };
    }
  }

  /**
   * Provision a new GHL Sub-Account (Location) for a signing-up celebrity,
   * apply the configured Snapshot, and create their Sub-Account Admin login user.
   * Matches the exact contract:
   * POST https://services.leadconnectorhq.com/locations/
   * Version: 2021-07-28
   */
  async provisionSubAccount({ name, email, websiteType, snapshotId, password }) {
    const targetSnapshot = snapshotId || this.env.GHL_SNAPSHOT_ID || (websiteType === 'ghl_hosted' ? this.defaultSnapshotId : null);

    if (!this.agencyKey) {
      // Mock / Sandbox response for local development & testing
      const mockLocationId = `loc_ghl_${Date.now()}`;
      const mockWidgetId = `wgt_${Math.random().toString(36).substring(2, 9)}`;
      const mockUser = await this.provisionSubAccountUser({ name, email, locationId: mockLocationId, password });
      return {
        success: true,
        isSimulated: true,
        locationId: mockLocationId,
        widgetId: mockWidgetId,
        snapshotApplied: targetSnapshot,
        userId: mockUser.userId,
        loginEmail: mockUser.loginEmail,
        tempPassword: mockUser.tempPassword,
        message: 'Sandbox Sub-Account provisioned successfully (Set GHL_AGENCY_API_KEY for live GHL provisioning).'
      };
    }

    try {
      const payload = {
        name: `${name} Official`,
        email: email,
        phone: '',
        city: '',
        state: '',
        country: this.env.GHL_DEFAULT_COUNTRY || 'US',
        postalCode: '',
        timezone: this.env.GHL_DEFAULT_TIMEZONE || 'America/New_York'
      };

      if (this.env.GHL_COMPANY_ID) {
        payload.companyId = this.env.GHL_COMPANY_ID;
      }

      if (targetSnapshot) {
        payload.snapshotId = targetSnapshot;
      }

      const res = await fetch(`${GHL_API_BASE}/locations/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.agencyKey}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const rawText = await res.text();
      let data = {};
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        throw new Error(`HTTP ${res.status}: ${rawText}`);
      }

      if (!res.ok || !data.id) {
        throw new Error(`HTTP ${res.status}: ${data.message || rawText || 'Missing location id in response'}`);
      }

      // Also create a Sub-Account Admin login user so the creator can sign in to HighLevel & authorize OAuth
      const subUser = await this.provisionSubAccountUser({
        name,
        email,
        locationId: data.id,
        password
      });

      return {
        success: true,
        isSimulated: false,
        locationId: data.id,
        widgetId: `wgt_${data.id}`,
        snapshotApplied: targetSnapshot,
        userId: subUser.userId || null,
        loginEmail: subUser.loginEmail || email || null,
        tempPassword: subUser.tempPassword || null
      };
    } catch (err) {
      console.error('[GHL provisionSubAccount Error]', err);
      return {
        success: false,
        error: err.message,
        locationId: `loc_fallback_${Date.now()}`,
        widgetId: `wgt_fallback_${Date.now()}`
      };
    }
  }

  /**
   * Fetch chat widget(s) for a specific GHL sub-account.
   * Endpoint: GET /chat-widget/list?locationId={locationId}
   * Requires scope: chat-widget.readonly
   */
  async getChatWidgets(locationId, accessToken = null) {
    const token = accessToken || this.agencyKey;
    if (!token) {
      return { success: true, isSimulated: true, widgets: [{ id: `wgt_${locationId}` }] };
    }

    try {
      const res = await fetch(`${GHL_API_BASE}/chat-widget/list?locationId=${encodeURIComponent(locationId)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': GHL_API_VERSION,
          'Accept': 'application/json'
        }
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `HTTP ${res.status}`);
      }

      return {
        success: true,
        widgets: data.widgets || data.chatWidgets || (Array.isArray(data) ? data : [data])
      };
    } catch (err) {
      console.warn('[GHL getChatWidgets Warning]', err.message);
      return { success: false, error: err.message, widgets: [] };
    }
  }

  /**
   * Customize the GHL Chat Widget styling via the API.
   * Endpoint: PUT /chat-widget/data/{locationId}/{widgetId}
   * Requires scope: chat-widget.write
   */
  async configureChatWidget({ locationId, widgetId, colors, fonts, avatarUrl, headline, welcomeMessage, accessToken = null }) {
    const token = accessToken || this.agencyKey;
    const customConfig = {
      primaryColor: colors.primary || '#3b82f6',
      accentColor: colors.accent || '#f59e0b',
      headingFont: fonts.heading || 'Space Grotesk',
      bodyFont: fonts.body || 'Inter',
      avatarUrl: avatarUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
      heading: headline || 'Ask My AI Twin',
      subheading: 'Official Digital Representative',
      welcomeMessage: welcomeMessage || 'Hey! Ask me anything about upcoming tour dates, VIP access, or projects!'
    };

    if (!token) {
      return { success: true, isSimulated: true, config: customConfig };
    }

    try {
      // 1. If widgetId not provided, attempt to look it up from the location
      let targetWidgetId = widgetId;
      if (!targetWidgetId || targetWidgetId.startsWith('wgt_')) {
        const listRes = await this.getChatWidgets(locationId, token);
        if (listRes.success && listRes.widgets && listRes.widgets.length > 0) {
          targetWidgetId = listRes.widgets[0].id || listRes.widgets[0]._id;
        }
      }

      if (!targetWidgetId) {
        return { success: false, error: 'No chat widget found for location', config: customConfig };
      }

      // 2. Update widget configuration via PUT /chat-widget/data/:locationId/:id
      const payload = {
        name: `${headline || 'Creator'} AI Twin Widget`,
        chatType: 'liveChat',
        settings: {
          headerTitle: customConfig.heading,
          subHeading: customConfig.subheading,
          avatar: customConfig.avatarUrl,
          themeColor: customConfig.primaryColor,
          headerColor: customConfig.primaryColor,
          introMessage: customConfig.welcomeMessage
        }
      };

      const res = await fetch(`${GHL_API_BASE}/chat-widget/data/${locationId}/${targetWidgetId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      return {
        success: res.ok,
        widgetId: targetWidgetId,
        config: customConfig,
        ghlResponse: data
      };
    } catch (err) {
      console.warn('[GHL configureChatWidget Warning]', err.message);
      return {
        success: false,
        error: err.message,
        config: customConfig
      };
    }
  }

  /**
   * Generates the official GoHighLevel Native Chat Widget script embed code
   */
  generateGhlNativeSnippet(widgetId) {
    return `<!-- Official GoHighLevel Branded Chat Widget -->
<script 
  src="https://widgets.leadconnectorhq.com/loader.js" 
  data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js"
  data-widget-id="${widgetId}">
</script>`;
  }

  /**
   * Upsert a fan contact strictly inside the authorized GHL Sub-Account (locationId).
   * POST https://services.leadconnectorhq.com/contacts/upsert
   * Requires scope: contacts.write
   */
  async upsertContact({ token, locationId, name, email, phone, tags = ['twwinz-fan'], source = 'Twwinz AI Twin Chat' }) {
    if (!locationId || String(locationId).startsWith('loc_')) {
      return {
        success: false,
        error: 'Valid HighLevel Sub-Account locationId is required to create or update contacts'
      };
    }

    if (!email && !phone) {
      return {
        success: false,
        error: 'Either email or phone is required to upsert a HighLevel contact'
      };
    }

    const authBearer = token || this.agencyKey;
    if (!authBearer) {
      return {
        success: true,
        isSimulated: true,
        locationId,
        contactId: `cnt_sim_${Date.now()}`
      };
    }

    try {
      const payload = {
        locationId,
        name: name || undefined,
        email: email || undefined,
        phone: phone || undefined,
        source,
        tags
      };

      const res = await fetch(`${GHL_API_BASE}/contacts/upsert`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authBearer}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      const contactObj = data.contact || data;
      return {
        success: res.ok,
        status: res.status,
        locationId,
        contactId: contactObj?.id || null,
        data
      };
    } catch (err) {
      console.error('[GHL upsertContact Error]', err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Send AI Twin's response back to the fan via GHL Conversations API.
   */
  async sendReplyToConversation({ locationApiKey, locationId, conversationId, contactId, replyText, messageType }) {
    const token = locationApiKey || this.agencyKey;

    if (!token) {
      return {
        success: true,
        isSimulated: true,
        replySent: replyText
      };
    }

    try {
      const msgPayload = {
        type: messageType || 'Live_Chat',
        contactId: contactId,
        message: replyText
      };
      if (conversationId) {
        msgPayload.conversationId = conversationId;
      }

      const res = await fetch(`${GHL_API_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(msgPayload)
      });

      const data = await res.json();
      return {
        success: res.ok,
        status: res.status,
        data
      };
    } catch (err) {
      console.error('[GHL sendReplyToConversation Error]', err);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Generates the custom embed code snippet ready for the celebrity to paste
   * into their WordPress, Squarespace, Wix, or Shopify site.
   */
  generateEmbedSnippet(creator, customOrigin = '') {
    const origin = customOrigin || 'https://twwinz.com';
    const slug = creator.slug;
    const colors = typeof creator.brand_colors === 'string' ? JSON.parse(creator.brand_colors || '{}') : (creator.brand_colors || {});
    const primary = colors.primary || '#3b82f6';
    const accent = colors.accent || '#f59e0b';
    const locationId = creator.ghl_location_id || 'demo';
    const fonts = typeof creator.brand_fonts === 'string' ? JSON.parse(creator.brand_fonts || '{}') : (creator.brand_fonts || {});
    const headingFont = fonts.heading || 'Space Grotesk';
    const bodyFont = fonts.body || 'Inter';

    return `<!-- Twwinz Branded AI Twin Chat Widget -->
<script 
  src="${origin}/widget.js" 
  data-creator="${slug}" 
  data-ghl-location="${locationId}"
  data-primary-color="${primary}"
  data-accent-color="${accent}"
  data-heading-font="${headingFont}"
  data-body-font="${bodyFont}"
  defer>
</script>
<noscript>Please enable JavaScript to chat with ${creator.name}'s official AI twin.</noscript>`;
  }
}
