import { Test, TestingModule } from '@nestjs/testing';
import { SignalDetectorService } from '@agent/signal-detector.service';

describe('SignalDetectorService', () => {
  let service: SignalDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SignalDetectorService],
    }).compile();

    service = module.get(SignalDetectorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('detect', () => {
    it('should detect salary need from keywords', () => {
      const { needs } = service.detect([{ role: 'user', content: '工资多少钱' }]);
      expect(needs).toContain('salary');
      expect(needs).not.toContain('none');
    });

    it('should detect schedule need from keywords', () => {
      const { needs } = service.detect([{ role: 'user', content: '排班是怎样的' }]);
      expect(needs).toContain('schedule');
    });

    it('should detect location need from keywords', () => {
      const { needs } = service.detect([{ role: 'user', content: '门店在哪' }]);
      expect(needs).toContain('location');
    });

    it('should detect multiple needs', () => {
      const { needs } = service.detect([{ role: 'user', content: '工资多少，在哪上班' }]);
      expect(needs).toContain('salary');
      expect(needs).toContain('location');
      expect(needs).not.toContain('none');
    });

    it('should return none when no keywords matched', () => {
      const { needs } = service.detect([{ role: 'user', content: '你好' }]);
      expect(needs).toEqual(['none']);
    });

    it('should detect needs from conversation history', () => {
      const { needs } = service.detect([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
        { role: 'user', content: '工资怎么算' },
      ]);
      expect(needs).toContain('salary');
    });

    it('should detect interview need', () => {
      const { needs } = service.detect([{ role: 'user', content: '怎么约面试' }]);
      expect(needs).toContain('interview');
    });

    it('should detect policy need', () => {
      const { needs } = service.detect([{ role: 'user', content: '有五险一金吗' }]);
      expect(needs).toContain('policy');
    });

    it('should detect requirements need', () => {
      const { needs } = service.detect([{ role: 'user', content: '有什么要求' }]);
      expect(needs).toContain('requirements');
    });

    it('should detect stores need', () => {
      const { needs } = service.detect([{ role: 'user', content: '有哪些店' }]);
      expect(needs).toContain('stores');
    });

    it('should detect availability need', () => {
      const { needs } = service.detect([{ role: 'user', content: '还有名额吗' }]);
      expect(needs).toContain('availability');
    });

    it('should detect age_sensitive risk flag', () => {
      const { riskFlags } = service.detect([{ role: 'user', content: '我今年16岁' }]);
      expect(riskFlags).toContain('age_sensitive');
    });

    it('should detect insurance_promise_risk flag', () => {
      const { riskFlags } = service.detect([{ role: 'user', content: '有五险一金吗' }]);
      expect(riskFlags).toContain('insurance_promise_risk');
    });

    it('should detect student-related age sensitivity', () => {
      const { riskFlags } = service.detect([{ role: 'user', content: '我是在校学生' }]);
      expect(riskFlags).toContain('age_sensitive');
    });

    it('should return empty riskFlags when no risk detected', () => {
      const { riskFlags } = service.detect([{ role: 'user', content: '你好' }]);
      expect(riskFlags).toEqual([]);
    });

    it('should detect both needs and riskFlags simultaneously', () => {
      const result = service.detect([{ role: 'user', content: '有社保吗，工资多少' }]);
      expect(result.needs).toContain('salary');
      expect(result.needs).toContain('policy');
      expect(result.riskFlags).toContain('insurance_promise_risk');
    });
  });

  describe('formatDetectionBlock', () => {
    it('should format needs and risk flags', () => {
      const block = service.formatDetectionBlock({
        needs: ['salary', 'location'],
        riskFlags: ['age_sensitive'],
      });

      expect(block).toContain('[检测到的需求]: salary, location');
      expect(block).toContain('[风险提醒]: age_sensitive');
    });

    it('should omit needs section when only none', () => {
      const block = service.formatDetectionBlock({
        needs: ['none'],
        riskFlags: [],
      });

      expect(block).not.toContain('[检测到的需求]');
      expect(block).not.toContain('[风险提醒]');
      expect(block).toBe('');
    });

    it('should only show risk flags when no needs', () => {
      const block = service.formatDetectionBlock({
        needs: ['none'],
        riskFlags: ['insurance_promise_risk'],
      });

      expect(block).not.toContain('[检测到的需求]');
      expect(block).toContain('[风险提醒]: insurance_promise_risk');
    });

    it('should only show needs when no risk flags', () => {
      const block = service.formatDetectionBlock({
        needs: ['salary'],
        riskFlags: [],
      });

      expect(block).toContain('[检测到的需求]: salary');
      expect(block).not.toContain('[风险提醒]');
    });
  });
});
