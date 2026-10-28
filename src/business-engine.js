'use strict';

const LINE_STAGES = [
  '初步认识',
  '熟悉互动',
  '信任建立',
  '重点跟进',
  '长期维护',
  '暂缓'
];

const LEAD_STAGES = [
  '新进线',
  '已接待',
  '有效聊天',
  '准备引导LINE',
  '已邀请LINE',
  'LINE已添加',
  '无效/暂停'
];

const LINE_STAGE_META = {
  '初步认识': { nextStage:'熟悉互动', action:'先回应客户当下内容，再自然分享自己，建立基本了解。', automation:'AI辅助回复' },
  '熟悉互动': { nextStage:'信任建立', action:'保持上下文连续，围绕生活、兴趣和真实感受增加熟悉度。', automation:'AI辅助 + 待回复识别' },
  '信任建立': { nextStage:'重点跟进', action:'优先真实共鸣和稳定互动，避免机械提问与生硬推进。', automation:'AI辅助 + 跟进提醒' },
  '重点跟进': { nextStage:'长期维护', action:'重要客户优先人工确认，AI负责上下文、提醒和建议。', automation:'人工优先' },
  '长期维护': { nextStage:'长期维护', action:'持续维护关系与聊天节奏，记住重要细节并避免重复话题。', automation:'AI辅助 + 周期提醒' },
  '暂缓': { nextStage:'暂缓', action:'暂停主动跟进，仅在客户再次来信时恢复处理。', automation:'暂停主动自动化' }
};

const LEAD_STAGE_META = {
  '新进线': { nextStage:'已接待', action:'尽快完成自然欢迎和第一轮回应，确认对方是有效真实客户。', automation:'快速接待' },
  '已接待': { nextStage:'有效聊天', action:'继续一到数轮轻量互动，判断回复意愿、兴趣和基本匹配度。', automation:'接待 + 意向判断' },
  '有效聊天': { nextStage:'准备引导LINE', action:'建立基础信任，不急着发 LINE；观察主动性、回复长度和互动稳定度。', automation:'意向评分' },
  '准备引导LINE': { nextStage:'已邀请LINE', action:'结合当前话题自然提出换到 LINE 继续聊，不要机械发送固定邀请。', automation:'建议引导 LINE' },
  '已邀请LINE': { nextStage:'LINE已添加', action:'等待添加结果；必要时进行一次自然提醒，避免重复轰炸。', automation:'LINE 添加确认' },
  'LINE已添加': { nextStage:'LINE已添加', action:'停止原平台主动引流与重复邀请，将长期聊天转入 LINE。', automation:'停止原平台主动跟进' },
  '无效/暂停': { nextStage:'无效/暂停', action:'停止自动跟进，除非客户重新主动发消息或人工恢复。', automation:'暂停自动化' }
};

const DEFINITIONS = {
  line: {
    id: 'relationship_chat',
    label: '聊天经营',
    goal: '长期聊天 · 关系维护 · 持续跟进',
    strategy: 'conversation_maintenance',
    defaultStage: LINE_STAGES[0],
    stages: LINE_STAGES,
    stageMeta: LINE_STAGE_META
  },
  lead: {
    id: 'lead_conversion',
    label: '引流转化',
    goal: '接待新线索 · 判断意向 · 自然引导添加 LINE',
    strategy: 'line_conversion',
    defaultStage: LEAD_STAGES[0],
    stages: LEAD_STAGES,
    stageMeta: LEAD_STAGE_META
  }
};

function normalizePlatform(platform = '') {
  return String(platform || '').trim().toLowerCase();
}

function businessTypeForPlatform(platform = '') {
  return normalizePlatform(platform) === 'line' ? 'line' : 'lead';
}

function businessDefinitionForPlatform(platform = '') {
  return DEFINITIONS[businessTypeForPlatform(platform)];
}

function defaultStageForPlatform(platform = '') {
  return businessDefinitionForPlatform(platform).defaultStage;
}

function stageMetaForPlatform(platform = '', stage = '') {
  const def = businessDefinitionForPlatform(platform);
  const normalized = String(stage || '').trim() || def.defaultStage;
  return def.stageMeta[normalized] || {
    nextStage: normalized,
    action: def.id === 'relationship_chat'
      ? '保持自然聊天和上下文连续，根据关系进度决定是否继续推进。'
      : '继续接待并判断客户意向，达到合适时机后再自然引导 LINE。',
    automation: def.id === 'relationship_chat' ? 'AI辅助聊天' : '引流接待'
  };
}

function lineConversionStatus(stage = '') {
  const value = String(stage || '').trim();
  if (value === 'LINE已添加') return 'added';
  if (value === '已邀请LINE') return 'invited';
  if (value === '准备引导LINE') return 'ready';
  if (value === '有效聊天') return 'qualified';
  if (value === '已接待') return 'engaged';
  if (value === '无效/暂停') return 'paused';
  return 'new';
}

function crmBusinessFields(platform = '', stage = '') {
  const def = businessDefinitionForPlatform(platform);
  const value = String(stage || '').trim() || def.defaultStage;
  const meta = stageMetaForPlatform(platform, value);
  return {
    businessRole: def.id,
    businessLabel: def.label,
    businessGoal: def.goal,
    automationStrategy: def.strategy,
    nextRecommendedStage: meta.nextStage,
    nextRecommendedAction: meta.action,
    lineConversionStatus: def.id === 'lead_conversion' ? lineConversionStatus(value) : ''
  };
}

function rendererDefinitions() {
  return JSON.parse(JSON.stringify(DEFINITIONS));
}

module.exports = {
  LINE_STAGES,
  LEAD_STAGES,
  DEFINITIONS,
  businessTypeForPlatform,
  businessDefinitionForPlatform,
  defaultStageForPlatform,
  stageMetaForPlatform,
  crmBusinessFields,
  lineConversionStatus,
  rendererDefinitions
};
