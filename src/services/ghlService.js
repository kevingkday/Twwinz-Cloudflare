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
   * Provision a new GHL Sub-Account (Location) for a signing-up celebrity.
   * Matches the exact contract:
   * POST https://services.leadconnectorhq.com/locations/
   * Version: 2021-07-28
   */
  async provisionSubAccount({ name, email, websiteType, snapshotId }) {
    const targetSnapshot = websiteType === 'ghl_hosted' 
      ? (snapshotId || this.env.GHL_SNAPSHOT_ID || this.defaultSnapshotId) 
      : null;

    if (!this.agencyKey) {
      // Mock / Sandbox response for local development & testing
      const mockLocationId = `loc_ghl_${Date.now()}`;
      const mockWidgetId = `wgt_${Math.random().toString(36).substring(2, 9)}`;
      return {
        success: true,
        isSimulated: true,
        locationId: mockLocationId,
        widgetId: mockWidgetId,
        snapshotApplied: targetSnapshot,
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

      return {
        success: true,
        isSimulated: false,
        locationId: data.id,
        widgetId: `wgt_${data.id}`,
        snapshotApplied: targetSnapshot
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
  async getChatWidgets(locationId) {
    if (!this.agencyKey) {
      return { success: true, isSimulated: true, widgets: [{ id: `wgt_${locationId}` }] };
    }

    try {
      const res = await fetch(`${GHL_API_BASE}/chat-widget/list?locationId=${locationId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.agencyKey}`,
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
  async configureChatWidget({ locationId, widgetId, colors, fonts, avatarUrl, headline, welcomeMessage }) {
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

    if (!this.agencyKey) {
      return { success: true, isSimulated: true, config: customConfig };
    }

    try {
      // 1. If widgetId not provided, attempt to look it up from the location
      let targetWidgetId = widgetId;
      if (!targetWidgetId || targetWidgetId.startsWith('wgt_')) {
        const listRes = await this.getChatWidgets(locationId);
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
          'Authorization': `Bearer ${this.agencyKey}`,
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
   * Send AI Twin's response back to the fan via GHL Conversations API.
   */
  async sendReplyToConversation({ locationApiKey, locationId, conversationId, contactId, replyText }) {
    const token = locationApiKey || this.agencyKey;

    if (!token) {
      return {
        success: true,
        isSimulated: true,
        replySent: replyText
      };
    }

    try {
      const res = await fetch(`${GHL_API_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': GHL_API_VERSION,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'Live_Chat',
          conversationId: conversationId,
          contactId: contactId,
          message: replyText
        })
      });

      const data = await res.json();
      return {
        success: res.ok,
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
