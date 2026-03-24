'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const tools = require('../tools');

module.exports = {
  name: 'anthropic',
  label: 'Anthropic API',
  defaultModel: 'claude-opus-4-6',
  models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool: execToolFn, channel }) {
    if (!apiKey) {
      yield { type: 'done', fullText: 'Error: API key de Anthropic no configurada. Configurala en el panel ⚙️.' };
      return;
    }

    const client = new Anthropic({ apiKey });
    const toolDefs  = tools.toAnthropicFormat({ channel });
    const execTool  = execToolFn || tools.executeTool;
    const messages  = [...history];
    const usedModel = model || this.defaultModel;

    let fullText = '';
    let totalPromptTokens = 0, totalCompletionTokens = 0;

    while (true) {
      let response;
      try {
        response = await client.messages.create({
          model: usedModel,
          max_tokens: 4096,
          system: systemPrompt || undefined,
          messages,
          tools: toolDefs,
        });
      } catch (err) {
        yield { type: 'done', fullText: `Error Anthropic: ${err.message}` };
        return;
      }

      const u = response.usage;
      if (u) { totalPromptTokens += u.input_tokens || 0; totalCompletionTokens += u.output_tokens || 0; }

      // Acumular texto de los content blocks
      let assistantText = '';
      const toolUses = [];

      for (const block of response.content || []) {
        if (block.type === 'text') {
          assistantText += block.text;
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
        }
      }

      if (assistantText) {
        fullText += assistantText;
        yield { type: 'text', text: assistantText };
      }

      if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
        yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
        yield { type: 'done', fullText };
        return;
      }

      // Agregar respuesta del asistente al historial
      messages.push({ role: 'assistant', content: response.content });

      // Ejecutar tools y agregar resultados
      const toolResults = [];
      for (const toolUse of toolUses) {
        yield { type: 'tool_call', name: toolUse.name, args: toolUse.input };
        const result = await execTool(toolUse.name, toolUse.input || {});
        yield { type: 'tool_result', name: toolUse.name, result };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: String(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  },
};
