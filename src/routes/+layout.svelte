<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { initDB } from '$lib/stores/dbStore';
	import { pageTitle } from '$lib/stores/titleStore';
	import Header from '$lib/components/Header.svelte';

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
	<title>{$pageTitle}</title>
</svelte:head>

<style>
	.wrapper {
		display: flex;
		flex-direction: column;
	}
</style>

<div class="wrapper">
	<Header />
	{@render children?.()}
</div>
