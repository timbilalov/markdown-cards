<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { initDB } from '$lib/stores/dbStore';

	let { children } = $props();

	onMount(async () => {
		// Initialize the database when the app starts
		try {
			await initDB();
			console.log('Database initialized');
		} catch (error) {
			console.error('Failed to initialize database:', error);
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children?.()}

