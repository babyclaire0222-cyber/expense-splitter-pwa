// src/lib/supabase/types.ts
// This is a hand-written stub matching 0001_init.sql. Once you run
// `npx supabase gen types typescript` against your live project, replace
// this file with the generated output for full type safety on every query.

export interface Database {
	public: {
		Tables: {
			groups: {
				Row: {
					id: string;
					name: string;
					currency: string;
					join_code: string;
					created_by: string;
					created_at: string;
					updated_at: string;
					deleted_at: string | null;
				};
				Insert: Omit<Database['public']['Tables']['groups']['Row'], 'created_at' | 'updated_at'>;
				Update: Partial<Database['public']['Tables']['groups']['Insert']>;
			};
			members: {
				Row: {
					id: string;
					group_id: string;
					display_name: string;
					auth_user_id: string | null;
					role: 'creator' | 'member';
					status: 'pending' | 'approved' | 'rejected';
					approved_by: string | null;
					approved_at: string | null;
					joined_at: string;
					updated_at: string;
					deleted_at: string | null;
				};
				Insert: Omit<Database['public']['Tables']['members']['Row'], 'joined_at' | 'updated_at'>;
				Update: Partial<Database['public']['Tables']['members']['Insert']>;
			};
			expenses: {
				Row: {
					id: string;
					group_id: string;
					description: string;
					amount_cents: number;
					currency: string;
					paid_by_member_id: string;
					split_type: 'equal' | 'percentage' | 'custom';
					expense_date: string;
					created_by_member_id: string;
					created_at: string;
					updated_at: string;
					deleted_at: string | null;
					reversal_of_expense_id: string | null;
				};
				Insert: Omit<Database['public']['Tables']['expenses']['Row'], 'created_at' | 'updated_at'>;
				Update: Partial<Database['public']['Tables']['expenses']['Insert']>;
			};
			splits: {
				Row: {
					id: string;
					expense_id: string;
					member_id: string;
					share_cents: number;
					share_percentage: number | null;
					updated_at: string;
				};
				Insert: Omit<Database['public']['Tables']['splits']['Row'], 'updated_at'>;
				Update: Partial<Database['public']['Tables']['splits']['Insert']>;
			};
			audit_log: {
				Row: {
					id: string;
					entity_type: 'expense' | 'group' | 'member';
					entity_id: string;
					action: 'create' | 'edit' | 'delete' | 'reversal';
					performed_by_member_id: string;
					performed_at: string;
					snapshot: Record<string, unknown>;
				};
				Insert: Omit<Database['public']['Tables']['audit_log']['Row'], 'performed_at'>;
				Update: never; // audit log is append-only, no updates permitted
			};
		};
	};
}