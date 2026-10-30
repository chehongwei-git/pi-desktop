/** 桌面专用桥接：由现有 Pi 进程加载，仅使用公开扩展 API，不启动服务或运行时。 */
export const bridgeCommands = {
  reload: 'pi-desktop-reload-v1',
  models: 'pi-desktop-models-v1',
  navigate: 'pi-desktop-navigate-v1',
};

export default function desktopBridge(pi) {
  pi.registerCommand(bridgeCommands.navigate, {
    description: 'Desktop bridge v1: navigate the active session tree',
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) throw new Error('请等待当前任务完成后切换分支。');
      const input = JSON.parse(args);
      if (typeof input.entryId !== 'string' || !input.entryId) throw new Error('无效树节点。');
      const result = await ctx.navigateTree(input.entryId, { summarize: input.summarize === true });
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
        throw new Error('模型配置已读取，但部分提供商刷新失败，请检查提供商配置。');
      }
      if (current) {
        const model = ctx.modelRegistry.find(current.provider, current.id);
        if (!model) throw new Error('模型列表已刷新，当前模型已被删除，请重新选择模型。');
        if (!(await pi.setModel(model))) {
          throw new Error('模型列表已刷新，但当前模型认证不可用，请重新配置或选择模型。');
        }
      }
    },
  });
}
