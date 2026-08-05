#!/usr/bin/env tsx
/**
 * Render the beta-invite email to an HTML file so it can be read (and
 * screenshotted) without mailing a real tester.
 *
 * Usage: npx tsx scripts/preview-beta-invite.mts out.html [tester@example.com]
 *
 * Exists because the only other way to see this email was to send one, and the
 * recipients are a small list of real people who each get exactly one first
 * impression.
 */
import { writeFileSync } from 'fs';
import { betaInviteHtml } from '../src/lib/notifications/beta-invite';

const out = process.argv[2] ?? 'beta-invite.html';
const to = process.argv[3] ?? 'tester@example.com';
writeFileSync(out, `<body style="margin:0;background:#e9e9e6;padding:28px">${betaInviteHtml(to, 'https://camphawk.app')}</body>`);
console.log(`wrote ${out}`);
