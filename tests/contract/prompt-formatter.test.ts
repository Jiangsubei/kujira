import { describe, it, expect } from 'vitest';
import {
  formatPromptSection,
  formatFaceLibraryContext,
  formatPersonaContext,
  formatBehaviorContext,
  formatSlangContext,
  formatSessionRulesContext,
  formatUserProfilesContext,
  formatMemoryContext,
} from '../../src/prompt/formatter.js';
import type { FaceRecord } from '../../src/types/index.js';

describe('契约测试: 统一提示词与上下文格式化模块 (PromptFormatter Contract)', () => {
  describe('1. 基础 Section 格式化原语 (formatPromptSection)', () => {
    it('1.1 仅标题与正文时，生成规范的二级 Markdown 标题', () => {
      const res = formatPromptSection({
        title: '测试标题',
        content: '这是测试正文内容',
      });
      expect(res).toBe('## 测试标题\n\n这是测试正文内容');
    });

    it('1.2 带有中英文副标题与导语时，生成统一格式段落', () => {
      const res = formatPromptSection({
        title: '人格设定',
        subtitle: 'Persona',
        description: '请严格遵守以下人设要求：',
        content: '你是一个贴心的单聊助手。',
      });
      expect(res).toBe(
        '## 人格设定 (Persona)\n\n请严格遵守以下人设要求：\n\n你是一个贴心的单聊助手。'
      );
    });

    it('1.3 当正文为空或全为空白字符时，返回空字符串（静默防御）', () => {
      expect(formatPromptSection({ title: '空段', content: '' })).toBe('');
      expect(formatPromptSection({ title: '空白段', content: '   \n  ' })).toBe('');
    });
  });

  describe('2. 表情包全量上下文注入 (formatFaceLibraryContext)', () => {
    it('2.1 表情库为空时，返回空字符串保持静默', () => {
      const res = formatFaceLibraryContext([], 0);
      expect(res).toBe('');
    });

    it('2.2 表情库有数据时，按情绪分组列出各表情的 ID 与详细标签，且包含一步直发指引', () => {
      const mockFaces: FaceRecord[] = [
        {
          id: 'face_001',
          file_path: '/path/f1.png',
          md5: 'md5_1',
          source: 'manual',
          tags: ['猫咪', '摇尾巴', '可爱'],
          mood: '开心',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 5,
          added_at: 1000,
        },
        {
          id: 'face_002',
          file_path: '/path/f2.png',
          md5: 'md5_2',
          source: 'manual',
          tags: ['欢呼', '撒花'],
          mood: '开心',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 3,
          added_at: 1001,
        },
        {
          id: 'face_003',
          file_path: '/path/f3.png',
          md5: 'md5_3',
          source: 'manual',
          tags: ['熊猫头', '就这'],
          mood: '调侃',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 1,
          added_at: 1002,
        },
        {
          id: 'face_004',
          file_path: '/path/f4.png',
          md5: 'md5_4',
          source: 'manual',
          tags: ['问号', '疑惑'],
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 0,
          added_at: 1003,
        },
      ];

      const res = formatFaceLibraryContext(mockFaces, 4);

      expect(res).toContain('## 本地表情包库存 (Sticker & Meme Library)');
      expect(res).toContain('共 4 张可用表情包');
      expect(res).toContain('send_face(face_id="..."');

      expect(res).toContain('### 开心 (2)');
      expect(res).toContain('### 调侃 (1)');
      expect(res).toContain('### 通用/其他 (1)');

      expect(res).toContain('- face_001: 标签: 猫咪, 摇尾巴, 可爱');
      expect(res).toContain('- face_002: 标签: 欢呼, 撒花');
      expect(res).toContain('- face_003: 标签: 熊猫头, 就这');
      expect(res).toContain('- face_004: 标签: 问号, 疑惑');
    });

    it('2.3 标签为空时优雅回退为 "无"', () => {
      const mockFaces: FaceRecord[] = [
        {
          id: 'face_empty_tag',
          file_path: '/path/f.png',
          md5: 'md5_e',
          source: 'manual',
          tags: [],
          mood: '淡定',
          enabled: true,
          size: 1024,
          format: 'png',
          use_count: 0,
          added_at: 1000,
        },
      ];
      const res = formatFaceLibraryContext(mockFaces, 1);
      expect(res).toContain('### 淡定 (1)');
      expect(res).toContain('- face_empty_tag: 标签: 无');
    });
  });

  describe('3. 人格、行为、黑话与记忆统一格式化', () => {
    it('3.1 formatPersonaContext 产生统一的 ## 人格设定 (Persona) 格式', () => {
      const res = formatPersonaContext('你是一个智能小助手。');
      expect(res).toBe('## 人格设定 (Persona)\n\n你是一个智能小助手。');
    });

    it('3.2 formatBehaviorContext 产生统一的 ## 行为准则 (Behavior Guidelines) 格式', () => {
      const res = formatBehaviorContext('单聊原生支持 Markdown 富文本排版。');
      expect(res).toBe('## 行为准则 (Behavior Guidelines)\n\n单聊原生支持 Markdown 富文本排版。');
    });

    it('3.3 formatSlangContext 产生统一的 ## 黑话与梗知识库 (Slang & Memes) 格式（无社群残留）', () => {
      const res = formatSlangContext('- **草率了**：决定过快');
      expect(res).toContain('## 黑话与梗知识库 (Slang & Memes)');
      expect(res).not.toContain('社群');
      expect(res).toContain('query_slang');
      expect(res).toContain('- **草率了**：决定过快');
    });

    it('3.4 formatSessionRulesContext 与 formatMemoryContext 产生统一规范格式', () => {
      const rules = formatSessionRulesContext('### Session 记忆\n- 规则一');
      expect(rules).toBe('## 会话规则与约定 (Session Rules & Conventions)\n\n### Session 记忆\n- 规则一');

      const res = formatMemoryContext('### Session 记忆\n- 规则一');
      expect(res).toContain('## 会话规则与用户画像 (Memory & Profiles)');
      expect(res).toContain('### Session 记忆\n- 规则一');
    });

    it('3.5 formatUserProfilesContext 产生统一的 ## 用户画像与偏好 (User Profile) 格式（无群成员残留）', () => {
      const res = formatUserProfilesContext('### 用户画像\n- 喜欢 TypeScript');
      expect(res).toBe('## 用户画像与偏好 (User Profile)\n\n### 用户画像\n- 喜欢 TypeScript');
      expect(res).not.toContain('群成员');
    });
  });
});
