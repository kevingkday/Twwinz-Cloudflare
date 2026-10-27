-- Seed data for demo celebrity AI Twin: Jaxson Reed (Indie Sci-Fi Actor & Musician)

INSERT OR REPLACE INTO creators (
    id, name, slug, email, headline, bio_summary, website_type, website_url,
    brand_colors, brand_fonts, avatar_url, ghl_location_id, ghl_widget_id,
    persona_prompt, welcome_message, is_active
) VALUES (
    'clb_jaxson_reed',
    'Jaxson Reed',
    'jaxson-reed',
    'jaxson@example.com',
    'Star of "Nebula Runners" & Lead Guitarist for Electric Horizon',
    'Indie sci-fi actor best known for playing Commander Vane in "Nebula Runners". Currently touring with Electric Horizon.',
    'existing',
    'https://jaxsonreed.com',
    '{"primary":"#3b82f6","accent":"#f59e0b","background":"#0f172a","surface":"#1e293b"}',
    '{"heading":"Space Grotesk","body":"Inter"}',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
    'loc_ghl_demo_8829',
    'wgt_ghl_demo_4412',
    'You are Jaxson Reed''s official digital representative and twin. Speak warmly, with humble sci-fi wit and genuine enthusiasm for indie art. Keep responses under 3 sentences unless asked for tour dates or story details. Always mention verified upcoming appearances, exclusive backstage VIP passes, or Cameo link when relevant. Never give out personal phone numbers or make up unconfirmed film sequels.',
    'Hey there! Jaxson Reed''s digital twin here. Want to know where I am appearing next, how to get VIP passes, or hear what guitar gear I use on tour? Ask away!',
    1
);

-- Grounded Private Knowledge Items (Unindexed schedule, VIP perks, FAQs)
INSERT OR REPLACE INTO knowledge_items (id, creator_id, category, title, content, metadata, priority, is_active)
VALUES 
(
    'k_sched_01',
    'clb_jaxson_reed',
    'schedule',
    'Chicago GalaxyCon 2026 Appearance',
    'Jaxson Reed will be appearing at Chicago GalaxyCon at the Donald E. Stephens Convention Center from Friday, November 13 to Sunday, November 15, 2026. He will be at Booth #412 for autographs and photo ops from 11:00 AM - 4:00 PM daily. Panel on "The Making of Nebula Runners" is on Saturday at 2:30 PM in Main Ballroom B.',
    '{"date":"2026-11-13","venue":"Donald E. Stephens Convention Center, Rosemont IL","booth":"#412","tickets_url":"https://galaxycon.com/chicago","panel_time":"Saturday 2:30 PM"}',
    10,
    1
),
(
    'k_sched_02',
    'clb_jaxson_reed',
    'schedule',
    'Electric Horizon Album Release Show in Austin',
    'Jaxson and his band Electric Horizon are playing a secret acoustic release show at The Continental Club in Austin, TX on Friday, December 4, 2026. Doors open at 8:00 PM. Only 150 tickets available.',
    '{"date":"2026-12-04","venue":"The Continental Club, Austin TX","doors":"8:00 PM","ticket_link":"https://electrichorizonband.com/austin-secret"}',
    9,
    1
),
(
    'k_offer_01',
    'clb_jaxson_reed',
    'offer',
    'Secret Fan Discount for Nebula Runners Season 2 Blu-Ray Box Set',
    'Fans asking through this chat get an exclusive 25% off coupon code for the limited edition Nebula Runners Box Set. Promo code is NEBULA25 at checkout on shop.jaxsonreed.com. Includes a hand-signed mini poster.',
    '{"promo_code":"NEBULA25","discount":"25%","store_url":"https://shop.jaxsonreed.com","bonus":"Hand-signed mini poster"}',
    8,
    1
),
(
    'k_offer_02',
    'clb_jaxson_reed',
    'offer',
    'Personalized Video Shoutouts on Cameo',
    'Jaxson records custom birthday, congratulations, and sci-fi motivational videos on Cameo within 48 hours for $65. 20% of all proceeds go to the Wildlife Rescue Foundation.',
    '{"price":"$65","turnaround":"48 hours","booking_url":"https://cameo.com/jaxsonreed","charity":"Wildlife Rescue Foundation"}',
    7,
    1
),
(
    'k_faq_01',
    'clb_jaxson_reed',
    'faq',
    'What guitar and amp gear does Jaxson use?',
    'Jaxson plays a 1982 Fender Telecaster in Butterscotch Blonde through a 1965 Fender Deluxe Reverb Reissue. His primary pedals are the Strymon BigSky reverb and the King of Tone overdrive by Analog Man.',
    '{"guitar":"1982 Fender Telecaster","amp":"1965 Fender Deluxe Reverb","overdrive":"Analog Man King of Tone"}',
    5,
    1
),
(
    'k_faq_02',
    'clb_jaxson_reed',
    'faq',
    'Will there be a Nebula Runners Season 3?',
    'Nothing has been officially announced for Season 3 yet, but Jaxson has confirmed in private that the script treatment is completed and the production team is in talks with streaming distributors. Stay tuned to his newsletter for updates!',
    '{"status":"In development","announcement_pending":true}',
    6,
    1
);

-- Insert into FTS5 index for full-text search
INSERT OR REPLACE INTO knowledge_fts (id, creator_id, title, content)
SELECT id, creator_id, title, content FROM knowledge_items WHERE creator_id = 'clb_jaxson_reed';
