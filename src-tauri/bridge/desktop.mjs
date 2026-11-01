/** 桌面专用桥接：由现有 Pi 进程加载，仅使用公开扩展 API，不启动服务或运行时。 */
export const bridgeCommands = {
  reload: 'pi-desktop-reload-v1',
  models: 'pi-desktop-models-v1',
  navigate: 'pi-desktop-navigate-v1',
  thinking: 'pi-desktop-thinking-v1',
};

export default function desktopBridge(pi) {
  // Pi 要求扩展等级显式映射；仅补缺省值，保留服务商映射和显式禁用。
  function defaultMappings(model) {
    model.thinkingLevelMap = {
      xhigh: 'xhigh',
      max: 'max',
      ...model.thinkingLevelMap,
    };
  }
  // 能力反映当前强度；只修改会话正在使用的模型，不重选模型或重置等级。
  const syncReasoning = (_event, ctx) => {
    if (ctx.model) {
      defaultMappings(ctx.model);
      ctx.model.reasoning = pi.getThinkingLevel() !== 'off';
    }
  };
  pi.on('session_start', syncReasoning);
  pi.on('model_select', syncReasoning);
  pi.on('thinking_level_select', syncReasoning);
  pi.on('before_agent_start', syncReasoning);
  pi.registerCommand(bridgeCommands.thinking, {
    description: 'Desktop bridge v1: apply thinking capability and level',
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) throw new Error('请等待当前任务完成后切换思考强度。');
      const { level } = JSON.parse(args);
      const model = ctx.model;
      if (model) defaultMappings(model);
      const levels = [
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ];
      if (
        !model ||
        !levels.includes(level) ||
        (level !== 'off' && model.thinkingLevelMap?.[level] === null)
      ) {
        throw new Error('当前模型不支持所选思考强度。');
      }
      const previousLevel = pi.getThinkingLevel();
      const previousReasoning = model.reasoning;
      try {
        // 先启用能力，避免 Pi 将指定强度收缩为 off；off 始终作为关闭入口保留。
        model.reasoning = level !== 'off';
        pi.setThinkingLevel(level);
        if (pi.getThinkingLevel() !== level)
          throw new Error('Pi 未应用所选思考强度。');
      } catch (error) {
        model.reasoning = true;
        pi.setThinkingLevel(previousLevel);
        model.reasoning = previousReasoning;
        throw error;
      }
    },
  });
  pi.registerCommand(bridgeCommands.navigate, {
    description: 'Desktop bridge v1: navigate the active session tree',
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) throw new Error('请等待当前任务完成后切换分支。');
      const input = JSON.parse(args);
      if (typeof input.entryId !== 'string' || !input.entryId)
        throw new Error('无效树节点。');
      const result = await ctx.navigateTree(input.entryId, {
        summarize: input.summarize === true,
      });
      if (result.cancelled) throw new Error('树导航已被 Pi 扩展取消。');
    },
  });
  pi.registerCommand(bridgeCommands.reload, {
    description: 'Desktop bridge v1: reload session resources',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) throw new Error('请等待当前任务完成后重载。');
      await ctx.reload();
      // 此处旧上下文已失效；模型刷新由桌面通过新命令上下文单独调用。
    },
  });
  pi.registerCommand(bridgeCommands.models, {
    description: 'Desktop bridge v1: refresh local model configuration',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) throw new Error('请等待当前任务完成后刷新模型。');
      const current = ctx.model;
      const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
      const configError = ctx.modelRegistry.getError();
      if (configError) throw new Error(`模型配置加载失败：${configError}`);
      if (result?.aborted) throw new Error('模型刷新已取消。');
      if (result?.errors?.size) {
        throw new Error(
          '模型配置已读取，但部分提供商刷新失败，请检查提供商配置。',
        );
      }
      if (current) {
        const model = ctx.modelRegistry.find(current.provider, current.id);
        if (!model)
          throw new Error('模型列表已刷新，当前模型已被删除，请重新选择模型。');
        if (!(await pi.setModel(model))) {
          throw new Error(
            '模型列表已刷新，但当前模型认证不可用，请重新配置或选择模型。',
          );
        }
      }
    },
  });
}
