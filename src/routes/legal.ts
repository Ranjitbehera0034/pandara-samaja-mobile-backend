import { FastifyInstance } from 'fastify';

// Public, unauthenticated legal pages required for Play Store submission
// (Play Console needs a live URL for the Data Safety section, and the app's
// own Settings screen links here). Kept as static server-rendered HTML
// rather than app screens since Play Console specifically requires a
// public web URL, not just in-app content.

const PAGE_STYLE = `
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 32px; }
  h2 { font-size: 18px; margin-top: 32px; }
  p, li { font-size: 15px; }
  ul { padding-left: 20px; }
  a { color: #0a66c2; }
`;

const EFFECTIVE_DATE = 'August 5, 2026';
// TODO: replace with the community's real contact address before submitting to Play Console.
const CONTACT_EMAIL = 'contact@nikhilaodishapandarasamaja.in';

const privacyPolicyHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Privacy Policy — Pandara Samaja</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p class="updated">Effective date: ${EFFECTIVE_DATE}</p>

<p>This Privacy Policy explains how Nikhila Odisha Pandara Samaja ("Pandara Samaja", "we", "us") collects, uses, and protects information through the Pandara Samaja mobile app ("the App"). The App is a private membership app for verified members of the Pandara Samaja community.</p>

<h2>Information We Collect</h2>
<ul>
  <li><strong>Membership &amp; registration data:</strong> membership number, head-of-household name, mobile number, gender, and address (village, panchayat, taluka, district), plus details of family members registered under the same membership (name, relation, gender, mobile number, photo).</li>
  <li><strong>Content you provide:</strong> profile photo, posts (text, photos, videos, audio), stories, comments, likes, poll votes, and — only if you choose to use the Matrimony feature — a matrimony profile.</li>
  <li><strong>Live streaming:</strong> if you start or watch a live stream, your video/audio (or the video/audio you view) is transmitted in real time to other viewers, and live comments are visible to viewers in real time. Live streams are not recorded or stored by the App.</li>
  <li><strong>Verification data:</strong> your mobile number is verified via Firebase Phone Authentication (OTP).</li>
  <li><strong>Device &amp; usage data:</strong> basic activity logs (e.g. login events and timestamps) for account security and support, and a push notification token if you enable notifications.</li>
</ul>

<h2>How We Use Information</h2>
<ul>
  <li>To operate the member directory and community features (feed, stories, events, live streaming, matrimony)</li>
  <li>To verify your identity via OTP at login</li>
  <li>To enable communication between members (posts, comments, live comments)</li>
  <li>To send notifications you have opted into</li>
  <li>To review content that other members report, for community safety</li>
  <li>To respond to support requests</li>
</ul>

<h2>Sharing of Information</h2>
<p>We do not sell your personal data. We share information only with service providers that help us run the App:</p>
<ul>
  <li><strong>Firebase / Google</strong> — phone number verification, media storage, and push notifications</li>
  <li><strong>Render.com</strong> — application hosting and database</li>
  <li><strong>LiveKit Cloud</strong> — live video streaming infrastructure</li>
</ul>
<p>Content you post (photos, posts, stories, your matrimony profile if enabled) is visible to other verified members of the App according to that feature's visibility rules.</p>

<h2>Data Retention</h2>
<p>We retain your information for as long as your membership record is active in the community, or until you request deletion.</p>

<h2>Your Choices &amp; Rights</h2>
<ul>
  <li>You can delete your own posts, stories, and comments at any time in the App.</li>
  <li>You can opt out of the Matrimony feature at any time.</li>
  <li>You can disable push notifications in Settings.</li>
  <li>You can request access to, correction of, or deletion of your data by contacting us (see below).</li>
</ul>

<h2>Children's Privacy</h2>
<p>The App is intended for use by adult members of the Pandara Samaja community. Family member records may include the names of minors as part of a household's membership record, submitted and managed by the adult head of household. The App is not designed for direct, independent use by children.</p>

<h2>Security</h2>
<p>We use industry-standard measures including encrypted connections (HTTPS/TLS), private cloud storage accessed only via time-limited signed links, and OTP/token-based authentication. No method of transmission or storage is 100% secure.</p>

<h2>Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. Continued use of the App after changes are posted constitutes acceptance of the updated policy.</p>

<h2>Contact Us</h2>
<p>Questions about this policy or your data can be sent to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
</body>
</html>`;

const termsOfServiceHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Terms of Service — Pandara Samaja</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>Terms of Service</h1>
<p class="updated">Effective date: ${EFFECTIVE_DATE}</p>

<p>These Terms of Service ("Terms") govern your use of the Pandara Samaja mobile app ("the App"), operated by Nikhila Odisha Pandara Samaja. By using the App, you agree to these Terms.</p>

<h2>Eligibility</h2>
<p>The App is available only to verified members of the Pandara Samaja community, identified by a registered membership number and mobile number.</p>

<h2>Your Account</h2>
<p>You are responsible for keeping your login and mobile number secure, and for providing accurate registration information. Contact us if you believe your account has been accessed without authorization.</p>

<h2>Acceptable Use</h2>
<p>When using the App, you agree not to post or transmit content that is illegal, abusive, harassing, obscene, or defamatory, and not to impersonate another person, spam other members, or otherwise disrupt the community.</p>

<h2>Content Ownership &amp; License</h2>
<p>You retain ownership of content you post. By posting content in the App, you grant Pandara Samaja a license to display that content to other verified members within the App.</p>

<h2>Moderation</h2>
<p>Content may be reported by other members and reviewed by Admins, who may remove content or suspend accounts that violate these Terms.</p>

<h2>Live Streaming</h2>
<p>The same conduct rules that apply to posted content apply during live streams. Live streams are not recorded or stored.</p>

<h2>Matrimony Feature</h2>
<p>The Matrimony feature is provided as a convenience to help members connect. Pandara Samaja does not guarantee matches and does not vet candidates beyond verifying community membership. You interact with other members through this feature at your own discretion.</p>

<h2>Disclaimer &amp; Limitation of Liability</h2>
<p>The App is provided "as is." Pandara Samaja is not liable for user-generated content or for interactions between members that occur through the App.</p>

<h2>Termination</h2>
<p>Admins may suspend or terminate accounts that violate these Terms.</p>

<h2>Governing Law</h2>
<p>These Terms are governed by the laws of India.</p>

<h2>Changes to These Terms</h2>
<p>We may update these Terms from time to time. Continued use of the App after changes are posted constitutes acceptance of the updated Terms.</p>

<h2>Contact Us</h2>
<p>Questions about these Terms can be sent to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
</body>
</html>`;

export default async function legalRoutes(fastify: FastifyInstance) {
  fastify.get('/privacy-policy', async (_req, reply) => {
    reply.type('text/html').send(privacyPolicyHtml);
  });

  fastify.get('/terms-of-service', async (_req, reply) => {
    reply.type('text/html').send(termsOfServiceHtml);
  });
}
