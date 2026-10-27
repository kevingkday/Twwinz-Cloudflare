/**
 * Style Scraper Service
 * Analyzes an existing website URL to extract:
 * - Dominant brand colors (primary, accent, background, surface)
 * - Typography (Google Fonts, custom font families)
 * - Favicon and Page Title
 * - Dark / Light theme detection
 * 
 * Used to automatically theme both the Twwinz chat widget and
 * the GoHighLevel chat widget so they natively blend into the creator's site.
 */

// Helper to convert 3 or 6 digit hex to RGB
function hexToRgb(hex) {
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map(c => c + c).join('');
  }
  if (clean.length !== 6) return null;
  const num = parseInt(clean, 16);
  if (isNaN(num)) return null;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

// Convert RGB to Hex
function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Compute HSL from RGB
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Convert HSL to Hex
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

// Clean font names extracted from Google Fonts, CSS rules, or style attributes
function cleanFontName(name) {
  if (!name) return null;
  let clean = decodeURIComponent(name).replace(/\+/g, ' ');
  // Strip Google font weights / styles (e.g. :wght@400;700 or :300,400)
  clean = clean.split(':')[0];
  // Strip quotes
  clean = clean.replace(/['"]/g, '').trim();
  // Strip generic fallbacks
  clean = clean.split(',')[0].trim();
  
  // Ignore generic CSS keywords
  const generic = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'inherit', 'initial', 'unset'];
  if (generic.includes(clean.toLowerCase())) return null;

  return clean;
}

// Build standard Google Fonts stylesheet URL
function buildGoogleFontsUrl(heading, body) {
  const families = [];
  if (heading) {
    const encodedH = encodeURIComponent(heading).replace(/%20/g, '+');
    families.push(`family=${encodedH}:wght@400;600;700`);
  }
  if (body && body !== heading) {
    const encodedB = encodeURIComponent(body).replace(/%20/g, '+');
    families.push(`family=${encodedB}:wght@400;500;600`);
  }
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}

export async function scrapeWebsiteStyles(url) {
  try {
    // Ensure valid URL
    let target = url.trim();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }
    const targetUrl = new URL(target);

    // Fetch target HTML with browser-like user agent
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);

    const res = await fetch(targetUrl.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Failed to fetch website (HTTP ${res.status})`);
    }

    const html = await res.text();

    // 1. Extract Page Title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : targetUrl.hostname;

    // 2. Extract Favicon / Logo
    let favicon = `${targetUrl.origin}/favicon.ico`;
    const iconMatch = html.match(/<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]+href=["']([^"']+)["']/i);
    if (iconMatch && iconMatch[1]) {
      const href = iconMatch[1];
      favicon = href.startsWith('http') ? href : new URL(href, targetUrl.origin).href;
    } else {
      // Check og:image
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (ogMatch && ogMatch[1]) {
        favicon = ogMatch[1].startsWith('http') ? ogMatch[1] : new URL(ogMatch[1], targetUrl.origin).href;
      }
    }

    // 3. Extract Fonts
    const fontNames = [];

    // Check Google Fonts links
    const gfMatches = html.match(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/gi) || [];
    for (const match of gfMatches) {
      const params = match.split('?')[1] || '';
      const parts = params.split('&');
      for (const p of parts) {
        if (p.startsWith('family=')) {
          const val = p.replace('family=', '');
          const rawList = val.split('|');
          for (const raw of rawList) {
            const clean = cleanFontName(raw);
            if (clean && !fontNames.includes(clean)) {
              fontNames.push(clean);
            }
          }
        }
      }
    }

    // Check CSS font-family in <style> blocks
    const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
    for (const block of styleBlocks) {
      const ffMatches = block.match(/font-family\s*:\s*([^;}{]+)/gi) || [];
      for (const ff of ffMatches) {
        const rawFamily = ff.replace(/font-family\s*:\s*/i, '');
        const clean = cleanFontName(rawFamily);
        if (clean && !fontNames.includes(clean)) {
          fontNames.push(clean);
        }
      }
    }

    let headingFont = fontNames.length > 0 ? fontNames[0] : 'Space Grotesk';
    let bodyFont = fontNames.length > 1 ? fontNames[1] : (fontNames[0] || 'Inter');

    // 4. Extract Colors
    let metaThemeColor = null;
    const themeColorMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
    if (themeColorMatch && themeColorMatch[1]) {
      const rgb = hexToRgb(themeColorMatch[1]);
      if (rgb) metaThemeColor = themeColorMatch[1].toLowerCase();
    }

    // Check CSS custom properties
    let cssBrandColor = null;
    const cssPropMatch = html.match(/--(?:primary|brand|accent|theme)[a-z0-9_-]*:\s*(#[0-9a-fA-F]{3,8})/i);
    if (cssPropMatch && cssPropMatch[1]) {
      cssBrandColor = cssPropMatch[1].toLowerCase();
    }

    // Extract all Hex colors in the HTML
    const rawHexMatches = html.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) || [];
    const saturatedCounts = {};
    const neutralCounts = {};

    for (const hex of rawHexMatches) {
      const rgb = hexToRgb(hex);
      if (!rgb) continue;
      const fullHex = rgbToHex(rgb.r, rgb.g, rgb.b).toLowerCase();
      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

      // Check if neutral/monochrome (low saturation or pure dark/light)
      if (hsl.s < 18 || hsl.l < 10 || hsl.l > 92) {
        neutralCounts[fullHex] = (neutralCounts[fullHex] || 0) + 1;
      } else {
        saturatedCounts[fullHex] = (saturatedCounts[fullHex] || 0) + 1;
      }
    }

    // Sort saturated colors by frequency
    const sortedSaturated = Object.keys(saturatedCounts).sort((a, b) => saturatedCounts[b] - saturatedCounts[a]);

    // Determine primary brand color
    let primaryColor = '#3b82f6'; // fallback default blue
    if (metaThemeColor) {
      primaryColor = metaThemeColor;
    } else if (cssBrandColor) {
      primaryColor = cssBrandColor;
    } else if (sortedSaturated.length > 0) {
      primaryColor = sortedSaturated[0];
    }

    // Determine accent color (must have vibrant saturation >= 35% and lightness between 35% and 80%)
    let accentColor = '#f59e0b'; // fallback warm amber
    let foundDistinct = null;

    const primaryRgb = hexToRgb(primaryColor);
    const primaryHsl = primaryRgb ? rgbToHsl(primaryRgb.r, primaryRgb.g, primaryRgb.b) : null;

    if (sortedSaturated.length > 1) {
      for (let i = 1; i < sortedSaturated.length; i++) {
        const candRgb = hexToRgb(sortedSaturated[i]);
        if (!candRgb) continue;
        const candHsl = rgbToHsl(candRgb.r, candRgb.g, candRgb.b);
        // Ensure good saturation and lightness
        if (candHsl.s >= 35 && candHsl.l >= 35 && candHsl.l <= 80) {
          if (!primaryHsl || Math.abs(primaryHsl.h - candHsl.h) > 25) {
            foundDistinct = sortedSaturated[i];
            break;
          }
        }
      }
    }

    if (foundDistinct) {
      accentColor = foundDistinct;
    } else {
      // Derive a radiant, harmonious accent from primary color
      if (primaryHsl) {
        const accentHue = (primaryHsl.h + 38) % 360;
        accentColor = hslToHex(accentHue, 88, 56);
      }
    }

    // Detect site background brightness (dark vs light)
    let isDark = true;
    const bodyBgMatch = html.match(/<body[^>]*style=["'][^"']*background(?:-color)?\s*:\s*([^;"']+)/i) ||
                        html.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/i);
    if (bodyBgMatch && bodyBgMatch[1]) {
      const bgRgb = hexToRgb(bodyBgMatch[1]);
      if (bgRgb) {
        const bgHsl = rgbToHsl(bgRgb.r, bgRgb.g, bgRgb.b);
        if (bgHsl.l > 55) isDark = false;
      }
    }

    const backgroundColor = isDark ? '#0f172a' : '#f8fafc';
    const surfaceColor = isDark ? '#1e293b' : '#ffffff';
    const textColor = isDark ? '#f8fafc' : '#0f172a';
    const googleFontsUrl = buildGoogleFontsUrl(headingFont, bodyFont);

    return {
      success: true,
      url: targetUrl.href,
      title,
      favicon,
      isDark,
      fonts: {
        heading: headingFont,
        body: bodyFont,
        googleFontsUrl
      },
      colors: {
        primary: primaryColor,
        accent: accentColor,
        background: backgroundColor,
        surface: surfaceColor,
        text: textColor,
        headerGradient: `linear-gradient(135deg, ${primaryColor} 0%, ${isDark ? '#090d16' : '#1e293b'} 100%)`
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      url,
      title: 'Creator Website',
      favicon: 'https://cdn-icons-png.flaticon.com/512/3135/3135715.png',
      isDark: true,
      fonts: {
        heading: 'Space Grotesk',
        body: 'Inter',
        googleFontsUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap'
      },
      colors: {
        primary: '#3b82f6',
        accent: '#f59e0b',
        background: '#0f172a',
        surface: '#1e293b',
        text: '#f8fafc',
        headerGradient: 'linear-gradient(135deg, #3b82f6 0%, #090d16 100%)'
      }
    };
  }
}
