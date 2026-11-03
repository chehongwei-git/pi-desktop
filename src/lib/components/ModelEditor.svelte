<!-- 模型能力就地展开；字段缺省表示继承，关闭和禁用必须显式保存。 -->
<script lang="ts">
  import SettingsSelect from './SettingsSelect.svelte';
  import {
    thinkingLabels,
    thinkingLevels,
    setThinkingMapping,
    defaultLevels,
    type ModelConfig,
    type ThinkingLevel,
  } from '../model-config';
  let {
    model = $bindable(),
    onremove,
    globalThinking = 'off',
  }: {
    model: ModelConfig;
    onremove: () => void;
    globalThinking?: string | null;
  } = $props();
  const reasoning = $derived(
    (model.defaultThinking ?? globalThinking ?? 'off') !== 'off',
  );
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
    <SettingsSelect
      label="图片输入"
      value={model.values.input === undefined
        ? ''
        : model.values.input.includes('image')
          ? 'true'
          : 'false'}
      options={[
        { value: '', label: '默认（文字与图片）' },
        { value: 'false', label: '仅文字' },
        { value: 'true', label: '文字与图片' },
      ]}
      onchange={(value) => {
        if (!value) delete model.values.input;
        else
          model.values.input = value === 'true' ? ['text', 'image'] : ['text'];
      }}
    />
  </div>
  {#if invalid}<p class="error" role="alert">
      上下文长度和最大输出须为正整数，且最大输出不得超过上下文长度。
    </p>{/if}
  <p>
    图片输入默认支持文字与图片，其他字段留空继承 Pi 默认值。
    上下文包含输入与输出；能力声明须与服务端一致，不会为模型增加能力。
  </p>
  <SettingsSelect
    label="此模型的默认思考等级"
    value={model.defaultThinking}
    options={[
      {
        value: null,
        label:
          '跟随全局默认（' +
          (thinkingLabels[globalThinking ?? 'off'] ?? globalThinking) +
          '）',
      },
      ...(model.defaultThinking &&
      !defaultLevels(model).includes(model.defaultThinking)
        ? [
            {
              value: model.defaultThinking,
              label: model.defaultThinking + '（已禁用，请更改）',
              disabled: true,
            },
          ]
        : []),
      ...defaultLevels(model).map((level) => ({
        value: level,
        label: thinkingLabels[level] ?? level,
      })),
    ]}
    onchange={(value) => {
      model.defaultThinking = value;
      // 能力与最终强度一起提交，跟随全局时以全局等级为准。
      model.values.reasoning = (value ?? globalThinking ?? 'off') !== 'off';
    }}
  />
  <p>思考{reasoning ? '已开启' : '已关闭'}，由最终生效的思考等级决定。</p>
  {#if model.defaultThinking && !defaultLevels(model).includes(model.defaultThinking)}<p
      class="error"
      role="status"
    >
      默认等级已被禁用，请重新选择。
    </p>{/if}
  <details class="thinking">
    <summary class="mapping-summary">
      <span class="mapping-heading">思考等级映射 <small>高级</small></span>
      <span class="mapping-count"
        >{Object.keys(model.values.thinkingLevelMap ?? {}).length
          ? '已调整 ' +
            Object.keys(model.values.thinkingLevelMap ?? {}).length +
            ' 项'
          : '使用默认'}</span
      >
    </summary>
    <div class="mapping-body">
      <p class="mapping-intro">
        通常无需修改。服务商要求特殊值时，可在这里调整或禁用等级。
      </p>
      {#each thinkingLevels as level}
        {@const mode = mapping(level)}
        {@const empty =
          mode === 'custom' && !model.values.thinkingLevelMap?.[level]?.trim()}
        <div class="mapping-row">
          <div class="mapping-level">
            <strong>{thinkingLabels[level].split(' · ')[0]}</strong><code
              >{level}</code
            >
          </div>
          <SettingsSelect
            label="支持方式"
            accessibleLabel={`${model.id} ${level} 支持方式`}
            value={mode}
            options={[
              { value: 'inherit', label: '继承默认' },
              { value: 'disabled', label: '不支持' },
              { value: 'custom', label: '自定义映射' },
            ]}
            onchange={(value) =>
              setThinkingMapping(model, level, value ?? 'inherit')}
          />
          <div class="mapping-value">
            {#if mode === 'custom'}
              <label
                >服务端值<input
                  aria-label={`${model.id} ${level} 服务端值`}
                  aria-invalid={empty}
                  required
                  placeholder={level}
                  value={model.values.thinkingLevelMap?.[level] ?? ''}
                  oninput={(e) => {
                    model.values.thinkingLevelMap = {
                      ...model.values.thinkingLevelMap,
                      [level]: e.currentTarget.value,
                    };
                  }}
                /></label
              >
              {#if empty}<p class="error" role="status">
                  请填写服务端接受的值。
                </p>{/if}
            {:else}<span class="mapping-placeholder"
                >{mode === 'disabled'
                  ? level === 'off'
                    ? '保留关闭入口'
                    : '不在强度列表中显示'
                  : level === 'xhigh' || level === 'max'
                    ? '默认值：' + level
                    : '使用协议或目录默认'}</span
              >{/if}
          </div>
        </div>
      {/each}
      <p class="mapping-note">
        xhigh、max 默认可选；实际支持范围由服务商决定。关闭入口始终保留。
      </p>
    </div>
  </details>
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
  .model-editor > summary span {
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
  input {
    width: 100%;
    min-width: 0;
    font-size: 12px;
  }
  p {
    font-size: 11px;
    line-height: 1.7;
    opacity: 0.8;
  }
  /* 按面板实际宽度响应，避免端点侧栏压缩三列表单。 */
  .thinking {
    container-type: inline-size;
    margin: 16px 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }
  .mapping-summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px;
    font-size: 13px;
    list-style: none;
  }
  .mapping-summary::-webkit-details-marker {
    display: none;
  }
  .mapping-summary::after {
    content: '⌄';
    color: var(--muted);
  }
  .thinking[open] > .mapping-summary::after {
    transform: rotate(180deg);
  }
  .mapping-summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 8px;
  }
  .mapping-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .mapping-heading small {
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 10px;
    font-weight: 400;
  }
  .mapping-count {
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 11px;
  }
  .mapping-body {
    padding: 0 12px 12px;
    border-top: 1px solid var(--border);
  }
  .mapping-intro,
  .mapping-note {
    color: var(--muted);
    opacity: 1;
  }
  .mapping-row {
    display: grid;
    grid-template-columns: 72px minmax(130px, 1fr) minmax(130px, 1fr);
    gap: 12px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .mapping-level {
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  .mapping-level code {
    color: var(--muted);
    font-size: 11px;
  }
  .mapping-value {
    min-width: 0;
  }
  .mapping-value label {
    margin: 8px 0;
  }
  .mapping-value input {
    min-height: 40px;
    border-radius: 9px;
    font-size: 13px;
  }
  .mapping-value input[aria-invalid='true'] {
    border-color: var(--error);
  }
  .mapping-placeholder {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  @container (max-width: 440px) {
    .mapping-row {
      grid-template-columns: 64px minmax(0, 1fr);
      gap: 0 12px;
    }
    .mapping-value {
      grid-column: 2;
      padding-bottom: 8px;
    }
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
