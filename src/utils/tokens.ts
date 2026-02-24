import { encoding_for_model, type TiktokenModel } from 'tiktoken';

/**
 * Accurately count the number of tokens in a string.
 * Uses exact Tiktoken models for OpenAI.
 * For Claude/Gemini, no local exact tokenizer exists in the Node ecosystem, 
 * so it safely falls back to cl100k_base (gpt-4) which is the industry standard
 * closest approximation for modern LLM token sizes.
 */
export function countTokens(text: string, modelName: string = 'gpt-4'): number {
  let model: TiktokenModel;
  
  if (modelName.includes('gpt-3.5')) {
    model = 'gpt-3.5-turbo';
  } else if (modelName.includes('gpt-4o') || modelName.includes('o1') || modelName.includes('o3') || modelName.includes('codex') || modelName.includes('gpt-5')) {
    model = 'gpt-4o'; // uses o200k_base which is correct for o1/o3/gpt-4o/codex
  } else if (modelName.includes('gpt-4')) {
    model = 'gpt-4'; // uses cl100k_base
  } else {
    model = 'gpt-4'; // Fallback approximation for Claude/Gemini
  }

  try {
    const enc = encoding_for_model(model);
    const count = enc.encode(text).length;
    enc.free();
    return count;
  } catch {
    try {
      const enc = encoding_for_model('gpt-4');
      const count = enc.encode(text).length;
      enc.free();
      return count;
    } catch {
      return Math.ceil(text.length / 3.5);
    }
  }
}

/**
 * Selectively prune older tool execution outputs and intermediate thought blocks
 * from a provider response to save token context.
 */
export function pruneResponseOutputs(response: string): string {
  // Prune long tool outputs
  let pruned = response.replace(/\[tool:.*?\][\s\S]*?(?=\n\[tool:|\n$|$)/g, (match) => {
    if (match.length > 500) {
      return match.substring(0, 200) + '\n...[Tool output truncated for token limit]...\n' + match.substring(match.length - 100);
    }
    return match;
  });
  
  // Prune thinking blocks (like <thinking> or <thought>)
  pruned = pruned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '<thinking>\n...[Thought block pruned for token limit]...\n</thinking>');
  pruned = pruned.replace(/<thought>[\s\S]*?<\/thought>/gi, '<thought>\n...[Thought block pruned for token limit]...\n</thought>');
  
  return pruned;
}
