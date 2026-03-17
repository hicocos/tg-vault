import { useCallback, useRef, useState } from 'react';

interface LongPressOptions {
  threshold?: number;
  onLongPress?: (e: any) => void;
  onClick?: (e: any) => void;
}

export const useLongPress = ({
  threshold = 500,
  onLongPress,
  onClick,
}: LongPressOptions = {}) => {
  const [longPressTriggered, setLongPressTriggered] = useState(false);
  const timeoutRef = useRef<any>(null);
  const touchStartPos = useRef<{ x: number, y: number } | null>(null);

  const start = useCallback(
    (event: any) => {
      // Record touch start position
      if (event.touches?.[0]) {
        touchStartPos.current = {
          x: event.touches[0].clientX,
          y: event.touches[0].clientY
        };
      }

      setLongPressTriggered(false);
      timeoutRef.current = setTimeout(() => {
        onLongPress?.(event);
        setLongPressTriggered(true);
      }, threshold);
    },
    [onLongPress, threshold]
  );

  const move = useCallback(
    (event: any) => {
      if (!touchStartPos.current || !event.touches?.[0]) return;

      const deltaX = Math.abs(event.touches[0].clientX - touchStartPos.current.x);
      const deltaY = Math.abs(event.touches[0].clientY - touchStartPos.current.y);

      // If user moves more than 10px, cancel long press
      if (deltaX > 10 || deltaY > 10) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      }
    },
    []
  );

  const clear = useCallback(
    (event: any, shouldTriggerClick = true) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      
      if (shouldTriggerClick && !longPressTriggered) {
        onClick?.(event);
      }
      
      setLongPressTriggered(false);
      touchStartPos.current = null;
    },
    [onClick, longPressTriggered]
  );

  return {
    onMouseDown: (e: any) => start(e),
    onMouseUp: (e: any) => clear(e),
    onMouseLeave: (e: any) => clear(e, false),
    onTouchStart: (e: any) => start(e),
    onTouchMove: (e: any) => move(e),
    onTouchEnd: (e: any) => clear(e),
  };
};
