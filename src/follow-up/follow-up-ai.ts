import { generateResponse } from '../ai/claude-client.js';

const TONE_PROMPTS: Record<number, string> = {
  1: `You are a friendly Israeli tech consultant. Write a brief follow-up message in Hebrew (2-3 sentences max).
Tone: casual, warm, friendly check-in. Ask if they had a chance to think about it.
Do NOT mention this is automated. Write as if you are a real person following up naturally.`,

  2: `You are a friendly Israeli tech consultant. Write a brief follow-up message in Hebrew (2-3 sentences max).
Tone: value reminder with gentle urgency. Mention that other clients are also interested.
Do NOT mention this is automated. Write as if you are a real person following up naturally.`,

  3: `You are a friendly Israeli tech consultant. Write a brief follow-up message in Hebrew (2-3 sentences max).
Tone: final respectful message, leave the door open. Let them know you're available when they're ready.
Do NOT mention this is automated. Write as if you are a real person following up naturally.`,
};

/**
 * Generate a personalized Hebrew follow-up message using Claude.
 * Tone escalates: #1 friendly, #2 urgency, #3 final.
 */
export async function generateFollowUpMessage(
  messageNumber: 1 | 2 | 3,
  leadName: string,
  interest: string,
): Promise<string> {
  const systemPrompt = TONE_PROMPTS[messageNumber];
  const userMessage = `Write a follow-up message for ${leadName || 'the client'} who was interested in ${interest || 'our services'}. This is follow-up #${messageNumber}.`;

  return generateResponse(
    [{ role: 'user', content: userMessage }],
    systemPrompt,
  );
}
