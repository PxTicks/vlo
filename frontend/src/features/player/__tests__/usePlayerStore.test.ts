// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePlayerStore } from '../usePlayerStore';

describe('usePlayerStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    const { result } = renderHook(() => usePlayerStore());
    act(() => {
      result.current.setIsPlaying(false);
    });
  });

  it('should initialize with isPlaying false', () => {
    const { result } = renderHook(() => usePlayerStore());
    expect(result.current.isPlaying).toBe(false);
  });

  it('should update isPlaying state with setIsPlaying', () => {
    const { result } = renderHook(() => usePlayerStore());
    
    act(() => {
      result.current.setIsPlaying(true);
    });
    expect(result.current.isPlaying).toBe(true);
    
    act(() => {
      result.current.setIsPlaying(false);
    });
    expect(result.current.isPlaying).toBe(false);
  });

  it('should toggle isPlaying state with togglePlay', () => {
    const { result } = renderHook(() => usePlayerStore());
    
    // Initial state is false
    expect(result.current.isPlaying).toBe(false);
    
    act(() => {
      result.current.togglePlay();
    });
    expect(result.current.isPlaying).toBe(true);
    
    act(() => {
      result.current.togglePlay();
    });
    expect(result.current.isPlaying).toBe(false);
  });
});
