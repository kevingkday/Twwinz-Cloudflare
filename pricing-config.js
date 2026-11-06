/**
 * Twwinz Single-Source Pricing Configuration
 * Edit all plan names, setup fees, monthly retainers, message caps, and attribution explanations here.
 * Any page loading `/pricing-config.js` automatically renders these values.
 */
(function (root) {
  const TWWINZ_PRICING = {
    currency: 'USD',
    updatedAt: '2026-04',
    starter: {
      id: 'starter',
      name: 'Starter',
      badge: 'Self-Serve • Budget Friendly',
      setupFee: '$0',
      setupLabel: 'No setup fee',
      monthlyFee: '$79',
      period: '/mo',
      messageCap: 'Up to 1,000 fan messages / mo',
      description: 'Built for independent personalities, convention guests, authors, local hosts, and regional athletes who want an accurate fan chat without hiring a team.',
      setupIncludes: 'Sign in with Google, paste your appearance dates, FAQs, merch links, and photos into your dashboard, and go live in minutes on your hosted twwinz.com/<slug> page or your own website.',
      features: [
        'Hosted Twin Page at twwinz.com/your-name (no website required)',
        '1-Line Chat Widget for your existing site',
        'Chat-only AI Twin grounded in your private info & photos',
        'Up to 1,000 fan replies per month included',
        'Pause or delete your twin and content anytime'
      ],
      ctaText: 'Start Self-Serve Setup',
      ctaHref: 'onboard.html?plan=starter'
    },
    doneForYou: {
      id: 'done-for-you',
      name: 'Done-for-You',
      badge: 'Most Popular • White-Glove Setup',
      setupFee: '$1,000',
      setupLabel: 'One-time setup',
      monthlyFee: '$400',
      period: '/mo',
      messageCap: 'Up to 10,000 chat & voice replies / mo',
      description: 'We build, style, and connect everything for you — including voice cloning, custom website widget, GoHighLevel CRM workflow, and merch store integration.',
      setupIncludes: 'What the $1,000 setup includes: (1) A 1-on-1 onboarding & strategy call, (2) Custom voice clone trained on your approved podcast/video clips, (3) Custom-branded chat widget installed on your site + hosted twin page, (4) Initial upload & indexing of your appearances, bio, FAQs, and photos, and (5) Shopify / merch store & GoHighLevel lead-capture setup.',
      features: [
        '1-on-1 Setup Call & initial content loading by our team',
        'Custom Voice Cloning (text + spoken audio replies)',
        'Custom-styled Website Widget + GoHighLevel CRM connection',
        'Shopify, Cameo & signed merch store integration',
        'Up to 10,000 fan interactions per month + priority convention updates'
      ],
      ctaText: 'Book Done-for-You Setup',
      ctaHref: 'onboard.html?plan=done-for-you'
    },
    successShare: {
      id: 'success-share',
      name: 'Success Share',
      badge: 'Aligned Upside',
      rate: '10%',
      rateLabel: 'on twin-attributed sales only',
      description: 'Your twin recommends signed merch, VIP bundles, Cameo shoutouts, and event tickets while answering fan questions.',
      trackingTitle: 'How attributed sales are tracked:',
      trackingExplanation: 'We only count orders completed using a twin-exclusive discount code (like GALAXY20) or a tracked checkout link clicked directly inside the chat widget. Regular website orders, social links, and in-person convention table sales are never charged.',
      features: [
        'Tracked strictly via twin-generated discount codes & chat links',
        '0% fee on your regular store traffic or in-person table sales',
        'Automatic promo code delivery when fans ask about merch',
        'Captures booking inquiries & local appearance requests for free'
      ],
      ctaText: 'See How Attribution Works',
      ctaHref: 'performance-share.html'
    }
  };

  root.TWWINZ_PRICING = TWWINZ_PRICING;

  function applyPricingBindings() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-price-bind]').forEach(function (el) {
      const path = el.getAttribute('data-price-bind');
      if (!path) return;
      const value = path.split('.').reduce(function (acc, key) {
        return acc && acc[key] !== undefined ? acc[key] : undefined;
      }, TWWINZ_PRICING);
      if (value !== undefined && typeof value === 'string') {
        el.textContent = value;
      }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyPricingBindings);
    } else {
      applyPricingBindings();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);

