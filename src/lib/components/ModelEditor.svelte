<!-- 模型能力就地展开；字段缺省表示继承，关闭和禁用必须显式保存。 -->
<script lang="ts">
  import {
    thinkingLevels,
    setThinkingMapping,
    defaultLevels,
    type ModelConfig,
    type ThinkingLevel,
  } from '../model-config';
  let { model, onremove }: { model: ModelConfig; onremove: () => void } =
    $props();
  let confirm = $state(false);
  let root: HTMLDetailsElement;
  const invalid = $derived(
    (model.values.contextWindow !== undefined &&
      (!Number.isSafeInteger(model.values.contextWindow) ||
        model.values.contextWindow <= 0)) ||
      (model.values.maxTokens !== undefined &&
        (!Number.isSafeInteger(model.values.maxTokens) ||
          model.values.maxTokens <= 0)) ||
      (model.values.contextWindow !== undefined &&
        model.values.maxTokens !== undefined &&
        model.values.maxTokens > model.values.contextWindow),
  );
  function remove() {
    const next = root.nextElementSibling ?? root.previousElementSibling;
    onremove();
    queueMicrotask(() => {
      const target = next?.matches('button')
        ? next
        : next?.querySelector('summary, button, input');
      if (target instanceof HTMLElement) target.focus();
    });
  }
  function numeric(key: 'contextWindow' | 'maxTokens', value: string) {
    if (value === '') delete model.values[key];
    else model.values[key] = Number(value);
  }
  function booleanValue(key: 'reasoning', value: string) {
    if (value === '') delete model.values[key];
    else model.values[key] = value === 'true';
  }
  function mapping(level: ThinkingLevel) {
    const value = model.values.thinkingLevelMap?.[level];
    return value === undefined
      ? 'inherit'
      : value === null
        ? 'disabled'
        : 'custom';
  }
</script>

<details class="model-editor" bind:this={root}>
  <summary
    ><strong>{model.values.name || model.id || '新模型'}</strong><span
      >{model.overrideOnly ? '目录模型覆盖' : '自定义模型'} · {model.id}</span
    ></summary
  >
  <div class="fields">
    <label
      >模型 ID<input
        required
        value={model.id}
        oninput={(e) => (model.id = e.currentTarget.value)}
      /></label
    >
    <label
      >显示名称<input
        value={model.values.name ?? ''}
        placeholder="继承默认"
        oninput={(e) => {
          if (e.currentTarget.value) model.values.name = e.currentTarget.value;
          else delete model.values.name;
        }}
      /></label
    >
    <label
      >上下文长度（tokens）<input
        type="number"
        min="1"
        step="1"
        value={model.values.contextWindow ?? ''}
        placeholder="继承 Pi 默认"
        oninput={(e) => numeric('contextWindow', e.currentTarget.value)}
      /></label
    >
    <label
      >最大输出（tokens）<input
        type="number"
        min="1"
        step="1"
        max={model.values.contextWindow}
        value={model.values.maxTokens ?? ''}
        placeholder="继承 Pi 默认"
        oninput={(e) => numeric('maxTokens', e.currentTarget.value)}
      /></label
    >
    <label
      >图片输入<select
        value={model.values.input === undefined
          ? ''
          : model.values.input.includes('image')
            ? 'true'
            : 'false'}
        onchange={(e) => {
          const v = e.currentTarget.value;
          if (!v) delete model.values.input;
          else model.values.input = v === 'true' ? ['text', 'image'] : ['text'];
        }}
        ><option value="">继承默认</option><option value="false">仅文字</option
        ><option value="true">文字与图片</option></select
      ></label
    >
    <label
      >思考能力<select
        value={model.values.reasoning === undefined
          ? ''
          : String(model.values.reasoning)}
        onchange={(e) => booleanValue('reasoning', e.currentTarget.value)}
        ><option value="">继承默认</option><option value="true">支持</option
        ><option value="false">不支持</option></select
      ></label
    >
  </div>
  {#if invalid}<p class="error" role="alert">
      上下文长度和最大输出须为正整数，且最大输出不得超过上下文长度。
    </p>{/if}
  <p>
    留空继承 Pi
    默认值。上下文包含输入与输出；能力声明须与服务端一致，不会为模型增加能力。
  </p>
  {#if model.values.reasoning !== false}
    <details class="thinking">
      <summary>思考等级映射</summary>
      <p>
        通过 high 的未映射等级使用协议默认；xhigh、max
        需显式映射或继承目录中的映射。null 表示不支持。
      </p>
      {#each thinkingLevels as level}
        <div class="mapping-row">
          <label
            >{level}<select
              aria-label={`${model.id} ${level} 支持方式`}
              value={mapping(level)}
              onchange={(e) =>
                setThinkingMapping(model, level, e.currentTarget.value)}
              ><option value="inherit">继承默认</option><option value="disabled"
                >不支持</option
              ><option value="custom">自定义映射</option></select
            ></label
          >
          {#if mapping(level) === 'custom'}<label
              >服务端值<input
                aria-label={`${model.id} ${level} 服务端值`}
                required
                value={model.values.thinkingLevelMap?.[level] ?? ''}
                oninput={(e) => {
                  model.values.thinkingLevelMap = {
                    ...model.values.thinkingLevelMap,
                    [level]: e.currentTarget.value,
                  };
                }}
              /></label
            >{/if}
        </div>
      {/each}
    </details>
  {/if}
  <label
    >此模型的默认思考等级<select bind:value={model.defaultThinking}
      ><option value={null}>跟随全局默认</option
      >{#if model.defaultThinking && !defaultLevels(model).includes(model.defaultThinking)}<option
          value={model.defaultThinking}
          >{model.defaultThinking}（已禁用，请更改）</option
        >{/if}{#each defaultLevels(model) as level}<option value={level}
          >{level}</option
        >{/each}</select
    ></label
  >
  {#if model.defaultThinking && !defaultLevels(model).includes(model.defaultThinking)}<p
      class="error"
      role="status"
    >
      默认等级已被禁用，请重新选择。
    </p>{/if}
  {#if confirm}<div class="actions" role="status">
      <span>移除此模型配置及其默认思考等级？内置模型将恢复目录默认。</span
      ><button type="button" onclick={() => (confirm = false)}>保留</button
      ><button type="button" onclick={remove}>确认移除</button>
    </div>{:else}<button type="button" onclick={() => (confirm = true)}
      >移除模型配置</button
    >{/if}
</details>

<style>
  .model-editor {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    margin: 10px 0;
  }
  summary {
    cursor: pointer;
    overflow-wrap: anywhere;
    padding: 4px 0;
  }
  summary span {
    display: block;
    font-size: 11px;
    opacity: 0.7;
    margin: 5px 0;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin: 14px 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    min-width: 0;
    margin: 8px 0;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
    font-size: 12px;
  }
  p {
    font-size: 11px;
    line-height: 1.7;
    opacity: 0.8;
  }
  .mapping-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .thinking {
    margin: 16px 0;
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
  }
  .error {
    color: var(--error);
    opacity: 1;
  }
  @media (max-width: 600px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
</style>
