import { useEffect, useRef, useState } from 'react';

/**
 * 数字滚动动画：目标值变化时从当前显示值平滑过渡到新值（easeOutCubic）。
 * 尊重 prefers-reduced-motion（直接跳到目标值）。
 */
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(target);
  const displayedRef = useRef(target);
  const frameRef = useRef(0);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = displayedRef.current;
    if (reduceMotion || from === target) {
      displayedRef.current = target;
      setValue(target);
      return undefined;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + (target - from) * eased;
      displayedRef.current = current;
      setValue(current);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, durationMs]);

  return value;
}
