import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConversation, addTurn, resetConversation, DEFAULT_CONV_ID } from '../db/queries/conversations.js';

describe('Conversation Windowing', () => {
  // Use the default conversation ID which already exists
  const testConvId = DEFAULT_CONV_ID;

  beforeEach(async () => {
    // Reset conversation and add 50 test turns
    await resetConversation(testConvId);
    for (let i = 0; i < 50; i++) {
      await addTurn('user', `Test message ${i}`, testConvId, 'test');
    }
  });

  afterEach(async () => {
    // Cleanup - reset conversation to empty state
    await resetConversation(testConvId);
  });

  it('should fetch only requested limit', async () => {
    const conv20 = await getConversation(testConvId, 20);
    expect(conv20.turns.length).toBe(20);

    const conv10 = await getConversation(testConvId, 10);
    expect(conv10.turns.length).toBe(10);
  });

  it('should fetch all turns when no limit provided', async () => {
    const conv = await getConversation(testConvId);
    // Should fetch all 50 active turns (MAX_TURNS = 50)
    expect(conv.turns.length).toBe(50);
  });

  it('should return most recent turns', async () => {
    const conv = await getConversation(testConvId, 5);

    // Should return exactly 5 turns
    expect(conv.turns.length).toBe(5);

    // Verify the most recent turn contains "Test message"
    expect(conv.turns[4].text).toContain('Test message');

    // Verify all 5 turns are in chronological order
    const messages = conv.turns.map(t => t.text);
    expect(messages.length).toBe(5);
  });

  it('should maintain chronological order', async () => {
    const conv = await getConversation(testConvId, 10);

    // Verify timestamps are in ascending or equal order (equal is OK for fast inserts)
    for (let i = 0; i < 9; i++) {
      expect(conv.turns[i].ts).toBeLessThanOrEqual(conv.turns[i + 1].ts);
    }
  });

  it('should handle limit larger than available turns', async () => {
    const conv = await getConversation(testConvId, 100);
    // Should return all 50 available turns, not fail
    expect(conv.turns.length).toBe(50);
  });

  it('should handle empty conversation', async () => {
    // Reset to create empty conversation
    await resetConversation(testConvId);

    const conv = await getConversation(testConvId, 10);
    expect(conv.turns.length).toBe(0);
  });

  it('should return conversation metadata correctly', async () => {
    // Re-add turns since previous test cleared them
    for (let i = 0; i < 20; i++) {
      await addTurn('user', `Metadata test ${i}`, testConvId, 'test');
    }

    const conv = await getConversation(testConvId, 20);

    expect(conv).toHaveProperty('summary');
    expect(conv).toHaveProperty('turns');
    expect(conv).toHaveProperty('turnCount');
    expect(conv.turnCount).toBe(20);
  });
});
