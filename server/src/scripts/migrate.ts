/**
 * One-off data updates, safe to run repeatedly:
 *  - renames activity categories that changed name, in profiles and activities
 *  - loads any built-in mock-test questions that are missing
 */
import { RENAMED_ACTIVITY_TYPES } from '../catalog.js';
import { loadConfig } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { Activity, StudentProfile } from '../models.js';
import { ensureQuestionBank } from '../services/questionBank.js';

const { mongoUri } = loadConfig();
if (!mongoUri) throw new Error('MONGODB_URI is not set. See server/.env.example.');

await connectDatabase(mongoUri);
try {
  for (const [oldName, newName] of Object.entries(RENAMED_ACTIVITY_TYPES)) {
    const profiles = await StudentProfile.updateMany({ preferences: oldName }, { $set: { 'preferences.$[p]': newName } }, { arrayFilters: [{ p: oldName }] });
    const activities = await Activity.updateMany({ activityType: oldName }, { activityType: newName });
    console.log(`"${oldName}" -> "${newName}": ${profiles.modifiedCount} profile(s), ${activities.modifiedCount} activity(ies)`);
  }
  console.log(`Question bank: ${await ensureQuestionBank()} question(s) added`);
} finally {
  await disconnectDatabase();
}
