/** Ollama's omitted tag means latest, not a Models.dev identity lookup. */
export function ollamaModelId(model: string): string {
  if (!model || /[\s?#\\]/.test(model) || model.endsWith(':')) {
    throw new Error('Invalid Ollama model name');
  }
  return model.lastIndexOf(':') > model.lastIndexOf('/')
    ? model
    : `${model}:latest`;
}
