import { ref } from 'firebase/database';
import { database } from '../firebase';
import { useCallback } from 'react';

export function useFirebaseRefs(roomId: string | null, userId: string | null) {
  const getUserRef = useCallback(() => {
    if (!roomId) return null;
    return ref(database, `rooms/${roomId}/users/${userId}`);
  }, [roomId]);

  const getOffersRef = useCallback(() => {
    return ref(database, `rooms/${roomId}/offers`);
  }, [roomId]);

  const getAnswersRef = useCallback(() => {
    return ref(database, `rooms/${roomId}/answers`);
  }, [roomId]);

  const getCandidatesRef = useCallback(() => {
    return ref(database, `rooms/${roomId}/candidates`);
  }, [roomId]);

  return {
    getUserRef,
    getOffersRef,
    getAnswersRef,
    getCandidatesRef,
  };
}
