import { useEffect, useRef } from 'react';
import styles from '../../styles/index.module.scss';

// 品牌色粒子（与页面主题色一致）
const PALETTE = [0x6366f1, 0x8b5cf6, 0x38bdf8, 0xf472b6, 0xfbbf24];

/**
 * Hero 区 three.js 粒子背景：漂浮的彩色光斑 + 鼠标视差。
 * three 走动态 import（独立 chunk，不拖慢首屏）；尊重 prefers-reduced-motion；
 * 页面不可见 / Hero 滚出视口时暂停渲染。
 */
export default function HeroParticles() {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void import('three').then((THREE) => {
      if (disposed || !wrap.isConnected) return;

      const width = Math.max(1, wrap.clientWidth);
      const height = Math.max(1, wrap.clientHeight);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
      camera.position.z = 14;

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      wrap.appendChild(renderer.domElement);

      // 软圆光斑贴图（canvas 径向渐变），让粒子呈 bokeh 质感而非方块
      const sprite = (() => {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createRadialGradient(
          size / 2,
          size / 2,
          0,
          size / 2,
          size / 2,
          size / 2,
        );
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.4, 'rgba(255,255,255,0.55)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
      })();

      interface Layer {
        points: import('three').Points;
        geometry: import('three').BufferGeometry;
        material: import('three').PointsMaterial;
        base: Float32Array;
        phase: Float32Array;
        speed: Float32Array;
        amp: Float32Array;
      }

      const makeLayer = (count: number, size: number, opacity: number): Layer => {
        const base = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const phase = new Float32Array(count);
        const speed = new Float32Array(count);
        const amp = new Float32Array(count);
        const color = new THREE.Color();
        for (let i = 0; i < count; i += 1) {
          base[i * 3] = (Math.random() - 0.5) * 36;
          base[i * 3 + 1] = (Math.random() - 0.5) * 14;
          base[i * 3 + 2] = (Math.random() - 0.5) * 10;
          color.setHex(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
          colors[i * 3] = color.r;
          colors[i * 3 + 1] = color.g;
          colors[i * 3 + 2] = color.b;
          phase[i] = Math.random() * Math.PI * 2;
          speed[i] = 0.25 + Math.random() * 0.5;
          amp[i] = 0.4 + Math.random() * 1.1;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const material = new THREE.PointsMaterial({
          size,
          map: sprite,
          transparent: true,
          opacity,
          vertexColors: true,
          depthWrite: false,
          sizeAttenuation: true,
          // 深色主题下用加色混合，光斑叠加处会真正"发光"
          blending: THREE.AdditiveBlending,
        });
        const points = new THREE.Points(geometry, material);
        scene.add(points);
        return { points, geometry, material, base, phase, speed, amp };
      };

      // 三层粒子：密集小点铺氛围，中等光斑做层次，少量大光斑做焦外虚化
      const layers = [
        makeLayer(320, 0.22, 0.85),
        makeLayer(90, 0.55, 0.5),
        makeLayer(20, 1.7, 0.3),
      ];

      let visible = true;
      let mouseX = 0;
      let mouseY = 0;

      const onMouseMove = (event: MouseEvent) => {
        mouseX = (event.clientX / window.innerWidth) * 2 - 1;
        mouseY = (event.clientY / window.innerHeight) * 2 - 1;
      };
      window.addEventListener('mousemove', onMouseMove, { passive: true });

      const intersection = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
      });
      intersection.observe(wrap);

      const resize = new ResizeObserver(() => {
        const w = Math.max(1, wrap.clientWidth);
        const h = Math.max(1, wrap.clientHeight);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
      resize.observe(wrap);

      let raf = 0;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (!visible || document.hidden) return;
        const t = now * 0.001;
        for (const layer of layers) {
          const positions = layer.geometry.getAttribute('position') as import('three').BufferAttribute;
          const array = positions.array as Float32Array;
          for (let i = 0; i < layer.phase.length; i += 1) {
            const k = i * 3;
            array[k] = layer.base[k] + Math.cos(t * layer.speed[i] * 0.8 + layer.phase[i]) * layer.amp[i] * 0.6;
            array[k + 1] = layer.base[k + 1] + Math.sin(t * layer.speed[i] + layer.phase[i]) * layer.amp[i];
          }
          positions.needsUpdate = true;
          layer.points.rotation.y = Math.sin(t * 0.05) * 0.06;
        }
        // 鼠标视差：相机缓动跟随，幅度很小，只制造景深感
        camera.position.x += (mouseX * 1.1 - camera.position.x) * 0.04;
        camera.position.y += (-mouseY * 0.6 - camera.position.y) * 0.04;
        camera.lookAt(0, 0, 0);
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('mousemove', onMouseMove);
        intersection.disconnect();
        resize.disconnect();
        for (const layer of layers) {
          scene.remove(layer.points);
          layer.geometry.dispose();
          layer.material.dispose();
        }
        sprite.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return <div ref={wrapRef} className={styles.heroCanvasWrap} aria-hidden="true" />;
}
