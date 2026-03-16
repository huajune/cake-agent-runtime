---
name: frontend-standards
role: system
model: sonnet
visibility: global
description: >
  React + TypeScript 前端开发规范，包含组件结构、样式隔离、目录组织等最佳实践。
  开发 Dashboard 前端代码时必须遵循本文档。

tags:
  - frontend
  - react
  - typescript
  - scss
  - component

priority: high
---

# Frontend Development Standards

> **Complete reference manual** for React + TypeScript frontend development
>
> **FOR HUMAN DEVELOPERS**: Detailed examples and explanations
> **FOR AI AGENTS**: See [code-quality-guardian.md](code-quality-guardian.md) for enforcement checklist

**Last Updated**: 2025-01-05
**Applies To**: All code in `web/` directory
**Tech Stack**: React 18 + TypeScript + Vite + SCSS Modules

---

## Table of Contents

- [Directory Structure](#directory-structure)
- [Component Standards](#component-standards)
- [Style Standards](#style-standards)
- [Naming Conventions](#naming-conventions)
- [Import Organization](#import-organization)
- [Hooks Standards](#hooks-standards)
- [Forbidden Practices](#forbidden-practices)

---

## Directory Structure

### View Module Structure

Each view module uses a flat structure to avoid deep nesting:

```
src/view/{module-name}/
├── list/                      # List page (main page)
│   ├── components/            # UI components (flat layout)
│   │   ├── ComponentA/
│   │   │   ├── index.tsx
│   │   │   └── index.module.scss
│   │   ├── ComponentB/
│   │   │   ├── index.tsx
│   │   │   └── index.module.scss
│   │   └── ...
│   ├── hooks/                 # Feature hooks
│   │   ├── index.ts           # Unified exports
│   │   ├── useFeatureA.ts
│   │   └── useFeatureB.ts
│   ├── constants/             # Constants
│   │   └── index.ts
│   ├── styles/                # Page-level styles
│   │   └── index.module.scss
│   └── index.tsx              # Page entry
├── detail/                    # Detail page (if needed)
└── edit/                      # Edit page (if needed)
```

### Component Structure

Each component must be a separate folder with its own style file:

```
ComponentName/
├── index.tsx                  # Component logic (required)
├── index.module.scss          # Component styles (required)
├── components/                # Sub-components (optional, only if used exclusively by this component)
│   └── SubComponent/
│       ├── index.tsx
│       └── index.module.scss
├── hooks/                     # Component-specific hooks (optional)
│   └── useLocalState.ts
└── types.ts                   # Type definitions (optional, for complex components)
```

### Key Principles

```
✅ Correct - Flat structure:
├── components/
│   ├── ComponentA/           # Flat layout
│   ├── ComponentB/           # Flat layout
│   └── ComponentC/           # Flat layout

❌ Wrong - Deep nesting:
├── components/
│   └── ComponentA/
│       └── components/       # Don't nest components folders
│           └── ComponentB/
│               └── components/
│                   └── ComponentC/
```

---

## Component Standards

### Basic Component Template

```tsx
// ComponentName/index.tsx
import { useState, useCallback } from 'react';
import { SomeIcon } from 'lucide-react';
import styles from './index.module.scss';

interface ComponentNameProps {
  title: string;
  onAction?: (value: string) => void;
  disabled?: boolean;
}

export function ComponentName({ title, onAction, disabled = false }: ComponentNameProps) {
  const [value, setValue] = useState('');

  const handleClick = useCallback(() => {
    onAction?.(value);
  }, [value, onAction]);

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>{title}</h3>
      <button
        className={styles.button}
        onClick={handleClick}
        disabled={disabled}
      >
        <SomeIcon size={16} />
        Submit
      </button>
    </div>
  );
}

export default ComponentName;
```

### Export Patterns

```tsx
// ✅ Named export (recommended for sub-components)
export function MetricsRow() { ... }
export { MetricsRow };

// ✅ Default export (for page main components)
export default function ChatTester() { ... }

// ✅ Unified export file (hooks/index.ts)
export * from './useChatTest';
export * from './useFeedback';
// or
export { useChatTest } from './useChatTest';
export { useFeedback } from './useFeedback';
```

### Props Definition

```tsx
// ✅ Use interface for Props
interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}

// ✅ Destructure props with default values
export function Button({
  label,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  onClick,
  children,
}: ButtonProps) {
  // ...
}

// ❌ Never use any
interface BadProps {
  data: any;  // FORBIDDEN
  onAction: any;  // FORBIDDEN
}
```

---

## Style Standards

### SCSS Module Structure

```scss
// ComponentName/index.module.scss

// 1. Import global variables (required)
@use '@/assets/styles/variables' as *;

// 2. Animation definitions (if any)
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

// 3. Main container
.container {
  display: flex;
  flex-direction: column;
  gap: $spacing-md;
  padding: $spacing-lg;
}

// 4. Child element styles
.header {
  display: flex;
  align-items: center;
  gap: $spacing-sm;

  .title {
    font-size: $font-size-lg;
    font-weight: $font-weight-semibold;
    color: $text-primary;
  }
}

// 5. State variants
.button {
  padding: $spacing-sm $spacing-md;
  border-radius: $radius-md;

  &.primary {
    background: $primary;
    color: white;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &:hover:not(:disabled) {
    opacity: 0.9;
  }
}
```

### Style Isolation Rules

```scss
// ✅ Each component writes only its own styles
// MetricsRow/index.module.scss
.metricsRow {
  display: flex;
  gap: $spacing-md;
}

// ❌ Don't write other component styles in one file
// ChatTester/index.module.scss
.metricsRow { ... }      // Belongs to MetricsRow, don't write here
.feedbackModal { ... }   // Belongs to FeedbackModal, don't write here
```

### Using CSS Variables

```scss
// ✅ Use global variables
.container {
  padding: $spacing-md;           // Spacing variable
  font-size: $font-size-sm;       // Font variable
  color: $text-primary;           // Color variable
  border-radius: $radius-md;      // Radius variable
  background: $bg-primary;        // Background variable
}

// ❌ Don't hardcode values
.container {
  padding: 16px;                  // Should use $spacing-md
  font-size: 14px;                // Should use $font-size-sm
  color: #333333;                 // Should use $text-primary
}
```

---

## Naming Conventions

### Files & Folders

```bash
# ✅ Component folders: PascalCase
ChatTester/
MessagePartsAdapter/
FeedbackModal/

# ✅ Component entry: fixed as index.tsx
ChatTester/index.tsx
ChatTester/index.module.scss

# ✅ Hooks files: camelCase with use prefix
hooks/useChatTest.ts
hooks/useFeedback.ts

# ✅ Constants/config: camelCase or kebab-case
constants/index.ts
config/api-config.ts

# ❌ Wrong naming
chat-tester/              # Component folders should use PascalCase
ChatTester.tsx            # Should be in a folder, not direct file
use-chat-test.ts          # Hooks shouldn't use kebab-case
```

### CSS Classes

```scss
// ✅ camelCase (CSS Modules standard)
.containerWrapper { }
.headerTitle { }
.submitButton { }
.isActive { }
.hasError { }

// ❌ Don't use other naming conventions
.container-wrapper { }    // kebab-case
.container_wrapper { }    // snake_case
.ContainerWrapper { }     // PascalCase
```

### Variables & Functions

```tsx
// ✅ Component names: PascalCase
function ChatTester() { }
function MessagePartsAdapter() { }

// ✅ Variables/functions: camelCase
const isLoading = false;
const handleSubmit = () => { };
const fetchUserData = async () => { };

// ✅ Constants: UPPER_SNAKE_CASE
const API_TIMEOUT = 30000;
const MAX_RETRY_COUNT = 3;
const DEFAULT_PAGE_SIZE = 20;

// ✅ Types/interfaces: PascalCase
interface UserData { }
type ButtonVariant = 'primary' | 'secondary';
enum MessageType { TEXT, IMAGE }
```

---

## Import Organization

### Import Order

```tsx
// 1. React core
import { useState, useEffect, useCallback, useMemo } from 'react';

// 2. Third-party libraries
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Send, X } from 'lucide-react';

// 3. Project-level (@ alias)
import { api } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/Button';

// 4. Module-level (relative path ../)
import { useChatTest, useFeedback } from '../../hooks';
import { HISTORY_PLACEHOLDER } from '../../constants';

// 5. Component-level (sibling components ./)
import { MetricsRow } from '../MetricsRow';
import { FeedbackModal } from '../FeedbackModal';

// 6. Current component styles (last)
import styles from './index.module.scss';
```

### Path Alias Usage

```tsx
// ✅ Use @ alias for project-level modules
import { api } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';

// ✅ Use relative paths for module-internal files
import { useChatTest } from '../../hooks';
import { MetricsRow } from '../MetricsRow';
import styles from './index.module.scss';

// ❌ Don't use long relative paths for project-level modules
import { api } from '../../../../services/api';  // Should use @/services/api
```

---

## Hooks Standards

### Custom Hook Structure

```tsx
// hooks/useChatTest.ts
import { useState, useCallback, useRef } from 'react';
import { api } from '@/services/api';

interface UseChatTestOptions {
  onSuccess?: (result: ChatResult) => void;
  onError?: (error: Error) => void;
}

interface UseChatTestReturn {
  // State
  isLoading: boolean;
  error: string | null;
  result: ChatResult | null;

  // Actions
  sendMessage: (message: string) => Promise<void>;
  clearResult: () => void;

  // Refs (if needed)
  inputRef: React.RefObject<HTMLInputElement>;
}

export function useChatTest(options: UseChatTestOptions = {}): UseChatTestReturn {
  const { onSuccess, onError } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChatResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const sendMessage = useCallback(async (message: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.chat.send(message);
      setResult(response);
      onSuccess?.(response);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      onError?.(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [onSuccess, onError]);

  const clearResult = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return {
    isLoading,
    error,
    result,
    sendMessage,
    clearResult,
    inputRef,
  };
}
```

### Hook Export Pattern

```tsx
// hooks/index.ts
export { useChatTest } from './useChatTest';
export { useFeedback } from './useFeedback';
export { useLocalStorage } from './useLocalStorage';

// Also export types if needed
export type { UseChatTestOptions, UseChatTestReturn } from './useChatTest';
```

---

## Forbidden Practices

### Absolutely Forbidden

```tsx
// ❌ Sharing style files (multiple components using one scss file)
// ComponentA/index.tsx
import styles from '../SharedStyles.module.scss';  // FORBIDDEN

// ✅ Each component has its own style
// ComponentA/index.tsx
import styles from './index.module.scss';

// ❌ Deep directory nesting
components/A/components/B/components/C/  // FORBIDDEN (3 levels)

// ✅ Flat structure
components/A/
components/B/
components/C/

// ❌ Using any type
const handleData = (data: any) => { };  // FORBIDDEN

// ✅ Use specific types
const handleData = (data: UserData) => { };

// ❌ Inline styles (unless dynamically calculated)
<div style={{ padding: '16px', color: 'red' }}>  // FORBIDDEN

// ✅ Use CSS Modules
<div className={styles.container}>

// ❌ Direct DOM manipulation
document.getElementById('xxx').style.display = 'none';  // FORBIDDEN

// ✅ Use React state
const [isVisible, setIsVisible] = useState(true);
{isVisible && <Component />}

// ❌ Defining components inside components
function Parent() {
  function Child() { }  // FORBIDDEN - recreated every render
  return <Child />;
}

// ✅ Define components separately
function Child() { }
function Parent() {
  return <Child />;
}
```

### Strongly Discouraged

```tsx
// ⚠️ Avoid large components (>300 lines)
// Split into multiple sub-components

// ⚠️ Avoid too many useState
// Consider useReducer or custom hooks

// ⚠️ Avoid creating objects/arrays during render
<Component data={{ a: 1 }} />  // Creates new object every render

// ✅ Use useMemo
const data = useMemo(() => ({ a: 1 }), []);
<Component data={data} />

// ⚠️ Avoid unnecessary state
const [derivedValue, setDerivedValue] = useState(props.value * 2);
// Should compute directly
const derivedValue = props.value * 2;
```

---

## Quality Checklist

Before completing development, verify:

- [ ] Component has its own folder and style file
- [ ] No shared/mixed style files
- [ ] Directory nesting does not exceed 2 levels
- [ ] All Props have type definitions
- [ ] No `any` types used
- [ ] Styles use global variables ($spacing-*, $font-*, etc.)
- [ ] Import order is correct
- [ ] Hooks follow naming convention (use prefix)
- [ ] Constants are in constants/ folder
- [ ] Component code is < 300 lines

---

## Related Documents

- **[code-standards.md](code-standards.md)** - TypeScript general coding standards
- **[architecture-principles.md](architecture-principles.md)** - Architecture design principles
- **[code-quality-guardian.md](code-quality-guardian.md)** - Code quality checklist

---

**Document Purpose**: Authoritative reference for frontend development, ensuring consistency and maintainability of Dashboard code.
